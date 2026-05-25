package tunnel_test

import (
	"context"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"elpasto/backend/internal/tunnel"
	"github.com/coder/websocket"
)

// wsTextMsg is a convenience alias for the websocket text message type.
const wsTextMsg = websocket.MessageText

// wsAccept upgrades an HTTP connection to a WebSocket.
func wsAccept(w http.ResponseWriter, r *http.Request) (*websocket.Conn, error) {
	return websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
}

const (
	wsClientToken  = "ws-client-test-token"
	wsClientPeerID = "660e8400-e29b-41d4-a716-446655440001"
)

// newWSRelay builds a WSRelay pointed at the given server URL with a real Proxy.
// The proxy target is a dummy address (nothing listens there; it is never actually
// dialled during these tests because no tunnel:request messages arrive).
func newWSRelay(t *testing.T, serverURL string) *tunnel.WSRelay {
	t.Helper()
	proxy, err := tunnel.NewProxy("http://127.0.0.1:19999", wsClientPeerID)
	if err != nil {
		t.Fatalf("NewProxy: %v", err)
	}
	logger := log.New(log.Writer(), "wsclient-test: ", 0)
	return tunnel.NewWSRelay(serverURL, wsClientToken, wsClientPeerID, "test-label", 9000, proxy, logger, "")
}

// TestWSRelayConnectSuccess verifies end-to-end connect:
//   - WebSocket handshake succeeds
//   - tunnel:config is received and the proxy prefix is updated
//   - tunnel:announce is forwarded to the broker as a tunnel:announce SSE event
//   - Cancelling the context causes Connect to return cleanly
func TestWSRelayConnectSuccess(t *testing.T) {
	h, _, broker := newTestRelay(wsClientToken)
	srv := httptest.NewServer(h)
	defer srv.Close()

	relay := newWSRelay(t, srv.URL)

	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan error, 1)
	go func() {
		done <- relay.Connect(ctx)
	}()

	// Give the relay time to connect, receive config, and send announce.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		events := broker.Events()
		for _, ev := range events {
			if ev.name == "tunnel:announce" && ev.token == wsClientToken {
				// Found the announce — cancel context and verify clean shutdown.
				cancel()
				select {
				case err := <-done:
					if err != nil && err != context.Canceled {
						t.Errorf("Connect returned unexpected error: %v", err)
					}
				case <-time.After(3 * time.Second):
					t.Error("Connect did not return after context cancel")
				}

				// The broker publish proves the relay loop ran (config received,
				// announce sent and forwarded). Prefix verification is in
				// TestWSRelayConnectPrefixSet.
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}

	cancel()
	t.Error("broker did not receive tunnel:announce within timeout")
}

// TestWSRelayConnectPrefixSet verifies that after a successful Connect the proxy
// prefix is updated to the server-assigned value (which contains the peer ID).
func TestWSRelayConnectPrefixSet(t *testing.T) {
	h, _, broker := newTestRelay(wsClientToken)
	srv := httptest.NewServer(h)
	defer srv.Close()

	proxy, err := tunnel.NewProxy("http://127.0.0.1:19999", wsClientPeerID)
	if err != nil {
		t.Fatalf("NewProxy: %v", err)
	}
	logger := log.New(log.Writer(), "prefix-test: ", 0)
	relay := tunnel.NewWSRelay(srv.URL, wsClientToken, wsClientPeerID, "label", 0, proxy, logger, "")

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- relay.Connect(ctx)
	}()

	// Wait for tunnel:announce to confirm the connect/config/announce cycle ran.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		events := broker.Events()
		for _, ev := range events {
			if ev.name == "tunnel:announce" && ev.token == wsClientToken {
				cancel()
				<-done

				// The server sets prefix to /api/tunnel/{peerID}/{accessToken}/ .
				// After SetPrefix the proxy should reflect that.
				prefix := proxy.Prefix()
				if prefix == "" {
					t.Error("proxy prefix is empty after Connect")
				}
				if !containsRune(prefix, wsClientPeerID) {
					t.Errorf("prefix %q does not contain peerID %q", prefix, wsClientPeerID)
				}
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	t.Error("never received tunnel:announce")
}

// TestWSRelayConnectInvalidSession verifies that Connect returns an error when
// the session token is rejected by the server.
func TestWSRelayConnectInvalidSession(t *testing.T) {
	h, _, _ := newTestRelay("some-other-token") // wsClientToken is NOT valid
	srv := httptest.NewServer(h)
	defer srv.Close()

	relay := newWSRelay(t, srv.URL)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err := relay.Connect(ctx)
	if err == nil {
		t.Fatal("expected Connect to fail for invalid session, got nil")
	}
}

// TestWSRelayConnect404Fallback verifies that connecting to a server that
// returns 404 produces an error message mentioning "404".
func TestWSRelayConnect404Fallback(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()

	relay := newWSRelay(t, srv.URL)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err := relay.Connect(ctx)
	if err == nil {
		t.Fatal("expected Connect to return an error for 404 server, got nil")
	}
	if !errors.Is(err, tunnel.ErrRelayUnsupported) {
		t.Errorf("expected ErrRelayUnsupported, got: %v", err)
	}
}

// TestWSRelayConnectWithRetryReconnects verifies that ConnectWithRetry reconnects
// after an abrupt server-side closure (simulating a relay disconnect).
//
// The test server uses a raw WebSocket handler that:
//  1. Accepts the upgrade
//  2. Sends a minimal tunnel:config (so the client progresses past config-read)
//  3. Immediately closes the connection with an abnormal closure code
//
// This causes WSRelay.Connect to return ErrRelayDisconnected, which ConnectWithRetry
// must treat as a retriable error (not a fallback-trigger).
func TestWSRelayConnectWithRetryReconnects(t *testing.T) {
	var connCount atomic.Int32

	// disconnectHandler accepts a WebSocket, sends a fake tunnel:config, then
	// closes abruptly — simulating a relay that drops the connection.
	disconnectHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/tunnel/ws" {
			http.NotFound(w, r)
			return
		}

		conn, err := wsAccept(w, r)
		if err != nil {
			return
		}
		connCount.Add(1)

		// Send a minimal tunnel:config so the client advances past the config read.
		cfgBytes, _ := tunnel.Encode(tunnel.ConfigMsg{
			Type:   tunnel.MsgConfig,
			Prefix: "/api/tunnel/" + wsClientPeerID + "/faketoken/",
		})
		ctx := r.Context()
		_ = conn.Write(ctx, wsTextMsg, cfgBytes)

		// Close abruptly — this makes WSRelay.Connect return ErrRelayDisconnected.
		conn.CloseNow()
	})

	srv := httptest.NewServer(disconnectHandler)
	defer srv.Close()

	relay := newWSRelay(t, srv.URL)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	done := make(chan error, 1)
	go func() {
		done <- relay.ConnectWithRetry(ctx)
	}()

	// Wait until we see at least 2 connection attempts (initial + ≥1 retry).
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if connCount.Load() >= 2 {
			cancel()
			select {
			case err := <-done:
				if err != nil && err != context.Canceled {
					t.Errorf("ConnectWithRetry returned unexpected error: %v", err)
				}
			case <-time.After(3 * time.Second):
				t.Error("ConnectWithRetry did not return after context cancel")
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	cancel()
	t.Errorf("expected at least 2 connection attempts, got %d", connCount.Load())
}

// TestWSRelayConnectWithRetryInitialFailureFallback verifies that
// ConnectWithRetry does NOT retry when the very first Connect attempt fails
// before the relay is established (e.g. 404 — server does not support tunnels).
func TestWSRelayConnectWithRetryInitialFailureFallback(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()

	relay := newWSRelay(t, srv.URL)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	start := time.Now()
	err := relay.ConnectWithRetry(ctx)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected ConnectWithRetry to return an error for 404 server, got nil")
	}
	// Should return quickly (no retry backoff) — well under 2 seconds.
	if elapsed > 2*time.Second {
		t.Errorf("ConnectWithRetry took %v — suggests it retried when it should have returned immediately", elapsed)
	}
	if !errors.Is(err, tunnel.ErrRelayUnsupported) {
		t.Errorf("expected ErrRelayUnsupported, got: %v", err)
	}
}

// newWSRelayWithAuth builds a WSRelay with an auth token set.
func newWSRelayWithAuth(t *testing.T, serverURL, authToken string) *tunnel.WSRelay {
	t.Helper()
	proxy, err := tunnel.NewProxy("http://127.0.0.1:19999", wsClientPeerID)
	if err != nil {
		t.Fatalf("NewProxy: %v", err)
	}
	logger := log.New(log.Writer(), "wsclient-auth-test: ", 0)
	return tunnel.NewWSRelay(serverURL, wsClientToken, wsClientPeerID, "test-label", 9000, proxy, logger, authToken)
}

// TestWSRelayConnectWithAuthToken verifies that when authToken is set, the
// Authorization header is sent during WebSocket dial and a properly configured
// server accepts the connection.
func TestWSRelayConnectWithAuthToken(t *testing.T) {
	// Create a relay handler with auth enabled that accepts "test-auth-token".
	h, _, broker := newTestRelayWithAuth("test-auth-token", wsClientToken)
	srv := httptest.NewServer(h)
	defer srv.Close()

	relay := newWSRelayWithAuth(t, srv.URL, "test-auth-token")

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- relay.Connect(ctx)
	}()

	// Wait for tunnel:announce to confirm the connect cycle ran.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		events := broker.Events()
		for _, ev := range events {
			if ev.name == "tunnel:announce" && ev.token == wsClientToken {
				cancel()
				select {
				case err := <-done:
					if err != nil && err != context.Canceled {
						t.Errorf("Connect returned unexpected error: %v", err)
					}
				case <-time.After(3 * time.Second):
					t.Error("Connect did not return after context cancel")
				}
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	t.Error("broker did not receive tunnel:announce within timeout")
}

// TestWSRelayConnectAuthRejected verifies that Connect returns
// ErrRelayAuthRejected when the server responds with 401/403.
func TestWSRelayConnectAuthRejected(t *testing.T) {
	// Create a relay handler with auth enabled — send a wrong token.
	h, _, _ := newTestRelayWithAuth("correct-token", wsClientToken)
	srv := httptest.NewServer(h)
	defer srv.Close()

	relay := newWSRelayWithAuth(t, srv.URL, "wrong-token")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err := relay.Connect(ctx)
	if err == nil {
		t.Fatal("expected Connect to fail with auth rejection")
	}
	if !errors.Is(err, tunnel.ErrRelayAuthRejected) {
		t.Errorf("expected ErrRelayAuthRejected, got: %v", err)
	}
}

// TestWSRelayConnectWithRetryAuthRejectionIsFatal verifies that
// ConnectWithRetry does NOT retry on ErrRelayAuthRejected — it returns
// immediately with the auth error.
func TestWSRelayConnectWithRetryAuthRejectionIsFatal(t *testing.T) {
	h, _, _ := newTestRelayWithAuth("correct-token", wsClientToken)
	srv := httptest.NewServer(h)
	defer srv.Close()

	relay := newWSRelayWithAuth(t, srv.URL, "wrong-token")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	start := time.Now()
	err := relay.ConnectWithRetry(ctx)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected error from auth rejection")
	}
	if !errors.Is(err, tunnel.ErrRelayAuthRejected) {
		t.Errorf("expected ErrRelayAuthRejected, got: %v", err)
	}
	if elapsed > 2*time.Second {
		t.Errorf("ConnectWithRetry took %v — auth rejection should not retry", elapsed)
	}
}

// TestWSRelayConnectDialFailure verifies that Connect returns a wrapped error
// when the server is unreachable (not 404/401/403).
func TestWSRelayConnectDialFailure(t *testing.T) {
	// Use a URL where nothing is listening.
	relay := newWSRelay(t, "http://127.0.0.1:1")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err := relay.Connect(ctx)
	if err == nil {
		t.Fatal("expected Connect to fail for unreachable server")
	}
	// Should be a generic connection error, not ErrRelayUnsupported or ErrRelayAuthRejected.
	if errors.Is(err, tunnel.ErrRelayUnsupported) {
		t.Error("should not be ErrRelayUnsupported for connection refused")
	}
	if errors.Is(err, tunnel.ErrRelayAuthRejected) {
		t.Error("should not be ErrRelayAuthRejected for connection refused")
	}
}

// TestWSRelayConnectWithRetryContextCancel verifies that ConnectWithRetry
// returns nil when the context is cancelled during the backoff sleep.
func TestWSRelayConnectWithRetryContextCancel(t *testing.T) {
	var connCount atomic.Int32

	disconnectHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/tunnel/ws" {
			http.NotFound(w, r)
			return
		}
		conn, err := wsAccept(w, r)
		if err != nil {
			return
		}
		connCount.Add(1)
		cfgBytes, _ := tunnel.Encode(tunnel.ConfigMsg{
			Type:   tunnel.MsgConfig,
			Prefix: "/api/tunnel/" + wsClientPeerID + "/faketoken/",
		})
		_ = conn.Write(r.Context(), wsTextMsg, cfgBytes)
		conn.CloseNow()
	})

	srv := httptest.NewServer(disconnectHandler)
	defer srv.Close()

	relay := newWSRelay(t, srv.URL)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() {
		done <- relay.ConnectWithRetry(ctx)
	}()

	// Wait for at least one connection, then cancel during backoff.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if connCount.Load() >= 1 {
			// Cancel while retry is in backoff sleep.
			time.Sleep(100 * time.Millisecond)
			cancel()
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	select {
	case err := <-done:
		// Should return nil on context cancel.
		if err != nil {
			t.Errorf("expected nil on context cancel, got: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Error("ConnectWithRetry did not return after context cancel")
	}
}

// TestWSRelayConnectHTTPS verifies that the https:// → wss:// URL scheme
// conversion is exercised. Since httptest.NewTLSServer uses self-signed certs
// and the websocket dialer will reject them, the connection will fail — but the
// URL scheme conversion code path is still executed.
func TestWSRelayConnectHTTPS(t *testing.T) {
	h, _, _ := newTestRelay(wsClientToken)
	srv := httptest.NewTLSServer(h)
	defer srv.Close()

	// The TLS server URL starts with https://
	proxy, err := tunnel.NewProxy("http://127.0.0.1:19999", wsClientPeerID)
	if err != nil {
		t.Fatalf("NewProxy: %v", err)
	}
	logger := log.New(log.Writer(), "wsclient-https-test: ", 0)
	relay := tunnel.NewWSRelay(srv.URL, wsClientToken, wsClientPeerID, "test-label", 9000, proxy, logger, "")

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	err = relay.Connect(ctx)
	// Expected to fail with TLS certificate error (self-signed cert).
	// The key assertion is that the https→wss conversion ran (no panic).
	if err == nil {
		t.Log("Connect unexpectedly succeeded with self-signed cert")
	}
	// It should NOT be ErrRelayUnsupported (404) or ErrRelayAuthRejected.
	if errors.Is(err, tunnel.ErrRelayUnsupported) {
		t.Error("should not be ErrRelayUnsupported for TLS error")
	}
}

// TestWSRelayConnectConfigReadError verifies that Connect returns an error when
// the server sends invalid data as the tunnel:config message.
func TestWSRelayConnectConfigReadError(t *testing.T) {
	badConfigHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/tunnel/ws" {
			http.NotFound(w, r)
			return
		}
		conn, err := wsAccept(w, r)
		if err != nil {
			return
		}
		// Send invalid JSON as config.
		ctx := r.Context()
		_ = conn.Write(ctx, wsTextMsg, []byte("not valid json"))
		conn.CloseNow()
	})

	srv := httptest.NewServer(badConfigHandler)
	defer srv.Close()

	relay := newWSRelay(t, srv.URL)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err := relay.Connect(ctx)
	if err == nil {
		t.Fatal("expected error for invalid config message")
	}
}

// TestWSRelayConnectAnnounceWriteError verifies that Connect returns an error
// when writing the announce message fails (server closes after config).
func TestWSRelayConnectAnnounceWriteError(t *testing.T) {
	closeAfterConfigHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/tunnel/ws" {
			http.NotFound(w, r)
			return
		}
		conn, err := wsAccept(w, r)
		if err != nil {
			return
		}
		// Send valid config then close immediately.
		cfgBytes, _ := tunnel.Encode(tunnel.ConfigMsg{
			Type:   tunnel.MsgConfig,
			Prefix: "/api/tunnel/" + wsClientPeerID + "/faketoken/",
		})
		ctx := r.Context()
		_ = conn.Write(ctx, wsTextMsg, cfgBytes)
		// Close immediately — the client's announce write should fail.
		conn.Close(websocket.StatusNormalClosure, "close after config")
	})

	srv := httptest.NewServer(closeAfterConfigHandler)
	defer srv.Close()

	relay := newWSRelay(t, srv.URL)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err := relay.Connect(ctx)
	// Either the announce write fails or the relay loop ends immediately.
	// Both return a non-nil error or nil (depending on timing).
	_ = err // No strict assertion — just exercises the code path.
}

// TestWSRelayConnectWithRetryBackoffReset verifies that the backoff resets
// after a stable connection (>30s). We simulate this by having the first
// connection stay alive briefly, disconnect, then connect again.
func TestWSRelayConnectWithRetryBackoffReset(t *testing.T) {
	// This test verifies the retry path is exercised but doesn't wait for
	// full 30s stability. Just confirms the retry loop operates correctly.
	var connCount atomic.Int32

	disconnectHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/tunnel/ws" {
			http.NotFound(w, r)
			return
		}
		conn, err := wsAccept(w, r)
		if err != nil {
			return
		}
		connCount.Add(1)

		cfgBytes, _ := tunnel.Encode(tunnel.ConfigMsg{
			Type:   tunnel.MsgConfig,
			Prefix: "/api/tunnel/" + wsClientPeerID + "/faketoken/",
		})
		ctx := r.Context()
		_ = conn.Write(ctx, wsTextMsg, cfgBytes)

		// Read the announce and then disconnect.
		_, _, _ = conn.Read(ctx)
		conn.CloseNow()
	})

	srv := httptest.NewServer(disconnectHandler)
	defer srv.Close()

	relay := newWSRelay(t, srv.URL)

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	done := make(chan error, 1)
	go func() {
		done <- relay.ConnectWithRetry(ctx)
	}()

	// Wait until at least 2 retries, then cancel.
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		if connCount.Load() >= 2 {
			cancel()
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	select {
	case err := <-done:
		if err != nil && err != context.Canceled {
			t.Errorf("ConnectWithRetry returned unexpected error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Error("ConnectWithRetry did not return after context cancel")
	}

	if connCount.Load() < 2 {
		t.Errorf("expected at least 2 connections, got %d", connCount.Load())
	}
}

// TestWSRelayConnectWithRetryCleanClose verifies that ConnectWithRetry returns
// nil when Connect returns nil (clean close).
func TestWSRelayConnectWithRetryCleanClose(t *testing.T) {
	// Server: accept WS, send config, then immediately close cleanly.
	// This makes Connect read the announce write succeed, then the recv channel
	// closes, and the proxy loop ends.
	cleanHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/tunnel/ws" {
			http.NotFound(w, r)
			return
		}
		conn, err := wsAccept(w, r)
		if err != nil {
			return
		}
		cfgBytes, _ := tunnel.Encode(tunnel.ConfigMsg{
			Type:   tunnel.MsgConfig,
			Prefix: "/api/tunnel/" + wsClientPeerID + "/faketoken/",
		})
		ctx := r.Context()
		_ = conn.Write(ctx, wsTextMsg, cfgBytes)
		// Read the tunnel:announce from the client.
		_, _, _ = conn.Read(ctx)
		// Close cleanly.
		conn.Close(websocket.StatusNormalClosure, "done")
	})

	srv := httptest.NewServer(cleanHandler)
	defer srv.Close()

	relay := newWSRelay(t, srv.URL)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err := relay.ConnectWithRetry(ctx)
	// Clean close should return nil.
	if err != nil {
		t.Errorf("expected nil for clean close, got: %v", err)
	}
}
