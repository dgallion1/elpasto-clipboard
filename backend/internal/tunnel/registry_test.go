package tunnel_test

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"

	"elpasto/backend/internal/tunnel"
)

func TestRegistryRegisterAndGet(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	conn, err := reg.Register("peer-1", "session-abc", "")
	if err != nil {
		t.Fatalf("Register failed: %v", err)
	}

	if conn.PeerID != "peer-1" {
		t.Errorf("PeerID = %q, want %q", conn.PeerID, "peer-1")
	}
	if conn.Session != "session-abc" {
		t.Errorf("Session = %q, want %q", conn.Session, "session-abc")
	}
	if conn.AccessToken == "" {
		t.Error("AccessToken is empty")
	}
	expectedPrefix := "/api/tunnel/peer-1/"
	if !strings.HasPrefix(conn.Prefix, expectedPrefix) {
		t.Errorf("Prefix = %q, want prefix starting with %q", conn.Prefix, expectedPrefix)
	}

	got := reg.Get("peer-1")
	if got != conn {
		t.Error("Get returned different conn than Register")
	}
}

func TestRegistryDuplicatePeerID(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	_, err := reg.Register("peer-dup", "session-abc", "")
	if err != nil {
		t.Fatalf("first Register failed: %v", err)
	}

	_, err = reg.Register("peer-dup", "session-abc", "")
	if err == nil {
		t.Error("second Register with same peerID should fail, got nil error")
	}
}

func TestRegistrySessionLimit(t *testing.T) {
	reg := tunnel.NewRegistry(2, 100, "") // max 2 per session

	_, err := reg.Register("peer-1", "session-x", "")
	if err != nil {
		t.Fatalf("Register 1 failed: %v", err)
	}
	_, err = reg.Register("peer-2", "session-x", "")
	if err != nil {
		t.Fatalf("Register 2 failed: %v", err)
	}
	_, err = reg.Register("peer-3", "session-x", "")
	if err == nil {
		t.Error("Register 3 should fail (session limit), got nil error")
	}

	// Different session should still work
	_, err = reg.Register("peer-4", "session-y", "")
	if err != nil {
		t.Errorf("Register to different session should succeed: %v", err)
	}
}

func TestRegistryGlobalLimit(t *testing.T) {
	reg := tunnel.NewRegistry(10, 2, "") // max 2 global

	_, err := reg.Register("peer-1", "session-a", "")
	if err != nil {
		t.Fatalf("Register 1 failed: %v", err)
	}
	_, err = reg.Register("peer-2", "session-b", "")
	if err != nil {
		t.Fatalf("Register 2 failed: %v", err)
	}
	_, err = reg.Register("peer-3", "session-c", "")
	if err == nil {
		t.Error("Register 3 should fail (global limit), got nil error")
	}
}

func TestRegistryUnregister(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	_, err := reg.Register("peer-un", "session-abc", "")
	if err != nil {
		t.Fatalf("Register failed: %v", err)
	}

	reg.Unregister("peer-un")

	got := reg.Get("peer-un")
	if got != nil {
		t.Error("Get after Unregister should return nil")
	}

	// Re-registering the same peer should now succeed
	_, err = reg.Register("peer-un", "session-abc", "")
	if err != nil {
		t.Errorf("Re-register after Unregister failed: %v", err)
	}
}

func TestRegistrySendRequestAndDispatch(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	conn, err := reg.Register("peer-req", "session-abc", "")
	if err != nil {
		t.Fatalf("Register failed: %v", err)
	}

	reqID, ch, err := conn.CreateRequest()
	if err != nil {
		t.Fatalf("CreateRequest failed: %v", err)
	}
	if reqID == "" {
		t.Error("requestID is empty")
	}
	if ch == nil {
		t.Error("channel is nil")
	}

	// Dispatch a response
	payload := json.RawMessage(`{"type":"tunnel:response","requestId":"` + reqID + `","status":200}`)

	var wg sync.WaitGroup
	wg.Add(1)
	var received json.RawMessage
	go func() {
		defer wg.Done()
		received = <-ch
	}()

	conn.DispatchResponse(reqID, payload)
	wg.Wait()

	if string(received) != string(payload) {
		t.Errorf("received %s, want %s", received, payload)
	}

	// Complete the request
	conn.CompleteRequest(reqID)

	// Channel should be closed after CompleteRequest
	_, ok := <-ch
	if ok {
		t.Error("channel should be closed after CompleteRequest")
	}
}

func TestRegistryCreateRequestConcurrencyLimit(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	conn, err := reg.Register("peer-limit", "session-abc", "")
	if err != nil {
		t.Fatalf("Register failed: %v", err)
	}

	// Fill up to MaxConcurrentRequests
	ids := make([]string, 0, tunnel.MaxConcurrentRequests)
	for i := 0; i < tunnel.MaxConcurrentRequests; i++ {
		id, _, err := conn.CreateRequest()
		if err != nil {
			t.Fatalf("CreateRequest %d failed: %v", i, err)
		}
		ids = append(ids, id)
	}

	// One more should fail
	_, _, err = conn.CreateRequest()
	if err == nil {
		t.Error("CreateRequest beyond MaxConcurrentRequests should fail")
	}

	// After completing one, another should succeed
	conn.CompleteRequest(ids[0])
	_, _, err = conn.CreateRequest()
	if err != nil {
		t.Errorf("CreateRequest after completing one should succeed: %v", err)
	}
}

func TestRegistryShutdownClosesPending(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	conn, err := reg.Register("peer-shut", "session-abc", "")
	if err != nil {
		t.Fatalf("Register failed: %v", err)
	}

	_, ch1, err := conn.CreateRequest()
	if err != nil {
		t.Fatalf("CreateRequest 1 failed: %v", err)
	}
	_, ch2, err := conn.CreateRequest()
	if err != nil {
		t.Fatalf("CreateRequest 2 failed: %v", err)
	}

	reg.Shutdown()

	// All pending channels should be closed
	_, ok := <-ch1
	if ok {
		t.Error("ch1 should be closed after Shutdown")
	}
	_, ok = <-ch2
	if ok {
		t.Error("ch2 should be closed after Shutdown")
	}

	// Get should return nil after Shutdown
	if reg.Get("peer-shut") != nil {
		t.Error("Get after Shutdown should return nil")
	}
}

func TestRegistryClientProvidedAccessToken(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	// A token that decodes to != 24 bytes should be rejected.
	knownToken := "dGhpcyBpcyBhIHRlc3QgdG9rZW4h" // 22 bytes decoded, not 24 — will be rejected
	conn, err := reg.Register("peer-ct1", "session-ct", knownToken)
	if err != nil {
		t.Fatalf("Register failed: %v", err)
	}
	// Token was invalid (not 24 bytes), so server should have generated one.
	if conn.AccessToken == knownToken {
		t.Error("invalid client token should not be used")
	}
	if conn.AccessToken == "" {
		t.Error("server should have generated a token")
	}
	reg.Unregister("peer-ct1")

	// Now test with a valid 24-byte token.
	validToken := "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef" // 32 chars = 24 bytes in base64url
	conn2, err := reg.Register("peer-ct2", "session-ct", validToken)
	if err != nil {
		t.Fatalf("Register failed: %v", err)
	}
	if conn2.AccessToken != validToken {
		t.Errorf("AccessToken = %q, want %q (client-provided)", conn2.AccessToken, validToken)
	}
	if !strings.Contains(conn2.Prefix, validToken) {
		t.Errorf("Prefix %q should contain the client token %q", conn2.Prefix, validToken)
	}
}

func TestRegistryConnectionsBySession(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	conn1, err := reg.Register("peer-1", "session-a", "")
	if err != nil {
		t.Fatal(err)
	}
	conn2, err := reg.Register("peer-2", "session-a", "")
	if err != nil {
		t.Fatal(err)
	}
	conn3, err := reg.Register("peer-3", "session-b", "")
	if err != nil {
		t.Fatal(err)
	}

	reg.SetIP(conn1.PeerID, "10.0.0.1")
	reg.SetIP(conn2.PeerID, "10.0.0.2")
	reg.SetIP(conn3.PeerID, "10.0.0.1")

	conns := reg.ConnectionsBySession()
	if len(conns) != 2 {
		t.Fatalf("expected 2 sessions, got %d", len(conns))
	}
	if got := conns["session-a"]; !reflect.DeepEqual(got, []string{"10.0.0.1", "10.0.0.2"}) {
		t.Fatalf("session-a IPs = %v", got)
	}
	if got := conns["session-b"]; !reflect.DeepEqual(got, []string{"10.0.0.1"}) {
		t.Fatalf("session-b IPs = %v", got)
	}

	if total := reg.TunnelCount(); total != 3 {
		t.Errorf("total tunnels: got %d, want 3", total)
	}

	reg.Unregister("peer-1")
	conns = reg.ConnectionsBySession()
	if got := conns["session-a"]; !reflect.DeepEqual(got, []string{"10.0.0.2"}) {
		t.Errorf("session-a after unregister = %v", got)
	}
}

func TestRegistryTunnelBaseURLPrefix(t *testing.T) {
	// With trailing slash.
	reg := tunnel.NewRegistry(5, 100, "https://tunnel.example.com/")
	conn, err := reg.Register("peer-url", "session-a", "")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(conn.Prefix, "https://tunnel.example.com/peer-url/") {
		t.Errorf("prefix with trailing slash = %q", conn.Prefix)
	}
	reg.Unregister("peer-url")

	// Without trailing slash — should still produce correct URL.
	reg2 := tunnel.NewRegistry(5, 100, "https://tunnel.example.com")
	conn2, err := reg2.Register("peer-url2", "session-a", "")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(conn2.Prefix, "https://tunnel.example.com/peer-url2/") {
		t.Errorf("prefix without trailing slash = %q", conn2.Prefix)
	}

	// Empty base URL — should use default /api/tunnel/ prefix.
	reg3 := tunnel.NewRegistry(5, 100, "")
	conn3, err := reg3.Register("peer-url3", "session-a", "")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(conn3.Prefix, "/api/tunnel/peer-url3/") {
		t.Errorf("prefix with empty base = %q", conn3.Prefix)
	}
}

func TestRegistryConnectionsBySessionSkipsEmptyIP(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	conn, err := reg.Register("peer-noip", "session-c", "")
	if err != nil {
		t.Fatal(err)
	}

	conns := reg.ConnectionsBySession()
	if _, exists := conns["session-c"]; exists {
		t.Fatalf("expected session-c absent before IP is set, got %v", conns["session-c"])
	}
	if reg.TunnelCount() != 1 {
		t.Fatalf("TunnelCount = %d, want 1", reg.TunnelCount())
	}

	reg.SetIP(conn.PeerID, "10.0.0.9")
	conns = reg.ConnectionsBySession()
	if got := conns["session-c"]; !reflect.DeepEqual(got, []string{"10.0.0.9"}) {
		t.Fatalf("session-c IPs = %v", got)
	}
}

// --- Additional coverage tests ---

func TestRegistryNewRegistryDefaults(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "https://example.com/")

	if reg.TunnelCount() != 0 {
		t.Errorf("TunnelCount on fresh registry = %d, want 0", reg.TunnelCount())
	}
	if reg.Get("nonexistent") != nil {
		t.Error("Get on empty registry should return nil")
	}
	if list := reg.ListBySession("any-session"); list != nil {
		t.Errorf("ListBySession on empty registry = %v, want nil", list)
	}
	conns := reg.ConnectionsBySession()
	if len(conns) != 0 {
		t.Errorf("ConnectionsBySession on empty registry = %v, want empty", conns)
	}
}

func TestRegistryPerSessionLimitExact5(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	for i := 1; i <= 5; i++ {
		_, err := reg.Register(fmt.Sprintf("peer-%d", i), "session-full", "")
		if err != nil {
			t.Fatalf("Register peer-%d failed: %v", i, err)
		}
	}

	_, err := reg.Register("peer-6", "session-full", "")
	if err == nil {
		t.Error("6th registration in same session should fail")
	}
	if !strings.Contains(err.Error(), "per-session limit") {
		t.Errorf("error should mention per-session limit, got: %v", err)
	}

	reg.Unregister("peer-3")
	_, err = reg.Register("peer-6", "session-full", "")
	if err != nil {
		t.Errorf("Register after freeing a slot should succeed: %v", err)
	}
}

func TestRegistryGlobalLimitAfterUnregister(t *testing.T) {
	reg := tunnel.NewRegistry(100, 3, "")

	for i := 1; i <= 3; i++ {
		_, err := reg.Register(fmt.Sprintf("peer-g%d", i), fmt.Sprintf("session-%d", i), "")
		if err != nil {
			t.Fatalf("Register %d failed: %v", i, err)
		}
	}

	_, err := reg.Register("peer-g4", "session-4", "")
	if err == nil {
		t.Error("should fail at global limit")
	}
	if !strings.Contains(err.Error(), "global connection limit") {
		t.Errorf("error should mention global limit, got: %v", err)
	}

	reg.Unregister("peer-g2")
	_, err = reg.Register("peer-g4", "session-4", "")
	if err != nil {
		t.Errorf("Register after global unregister should succeed: %v", err)
	}

	if reg.TunnelCount() != 3 {
		t.Errorf("TunnelCount = %d, want 3", reg.TunnelCount())
	}
}

func TestRegistryUnregisterNonexistent(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	// Should not panic.
	reg.Unregister("does-not-exist")

	if reg.TunnelCount() != 0 {
		t.Errorf("TunnelCount after noop unregister = %d, want 0", reg.TunnelCount())
	}
}

func TestRegistryUnregisterCleansSessionCount(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	_, err := reg.Register("peer-only", "session-solo", "")
	if err != nil {
		t.Fatal(err)
	}

	reg.Unregister("peer-only")

	// The session counter should be fully cleaned up (deleted from map),
	// allowing re-registration up to the per-session limit.
	for i := 1; i <= 5; i++ {
		_, err := reg.Register(fmt.Sprintf("peer-re%d", i), "session-solo", "")
		if err != nil {
			t.Fatalf("Re-register %d failed (session counter not cleaned): %v", i, err)
		}
	}
}

func TestRegistryUnregisterClosesPendingRequests(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	conn, err := reg.Register("peer-pend", "session-p", "")
	if err != nil {
		t.Fatal(err)
	}

	_, ch1, err := conn.CreateRequest()
	if err != nil {
		t.Fatal(err)
	}
	_, ch2, err := conn.CreateRequest()
	if err != nil {
		t.Fatal(err)
	}

	reg.Unregister("peer-pend")

	if _, ok := <-ch1; ok {
		t.Error("ch1 should be closed after Unregister")
	}
	if _, ok := <-ch2; ok {
		t.Error("ch2 should be closed after Unregister")
	}
}

func TestRegistrySetIPUnknownPeer(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	// Should not panic.
	reg.SetIP("nonexistent-peer", "10.0.0.1")
}

func TestRegistrySetIPOverwrite(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	conn, err := reg.Register("peer-ip", "session-ip", "")
	if err != nil {
		t.Fatal(err)
	}

	reg.SetIP(conn.PeerID, "10.0.0.1")
	conns := reg.ConnectionsBySession()
	if got := conns["session-ip"]; !reflect.DeepEqual(got, []string{"10.0.0.1"}) {
		t.Fatalf("initial IP = %v", got)
	}

	reg.SetIP(conn.PeerID, "10.0.0.2")
	conns = reg.ConnectionsBySession()
	if got := conns["session-ip"]; !reflect.DeepEqual(got, []string{"10.0.0.2"}) {
		t.Fatalf("updated IP = %v", got)
	}
}

func TestRegistryListBySessionMultipleSessions(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	conn1, _ := reg.Register("peer-ls1", "session-alpha", "")
	conn1.Label = "my-app"
	conn1.Port = 8080

	conn2, _ := reg.Register("peer-ls2", "session-alpha", "")
	conn2.Label = "other-app"
	conn2.Port = 3000

	reg.Register("peer-ls3", "session-beta", "")

	list := reg.ListBySession("session-alpha")
	if len(list) != 2 {
		t.Fatalf("ListBySession session-alpha = %d entries, want 2", len(list))
	}

	found := map[string]bool{}
	for _, s := range list {
		found[s.PeerID] = true
		if !s.ServerRelay {
			t.Errorf("ServerRelay should be true for %s", s.PeerID)
		}
	}
	if !found["peer-ls1"] || !found["peer-ls2"] {
		t.Errorf("missing expected peers: %v", found)
	}

	list = reg.ListBySession("session-beta")
	if len(list) != 1 {
		t.Fatalf("ListBySession session-beta = %d, want 1", len(list))
	}

	list = reg.ListBySession("session-unknown")
	if list != nil {
		t.Errorf("ListBySession unknown = %v, want nil", list)
	}
}

func TestRegistryListBySessionLabelAndPort(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	conn, _ := reg.Register("peer-lp", "session-lp", "")
	conn.Label = "dev-server"
	conn.Port = 9000

	list := reg.ListBySession("session-lp")
	if len(list) != 1 {
		t.Fatalf("expected 1 tunnel, got %d", len(list))
	}
	if list[0].Label != "dev-server" {
		t.Errorf("Label = %q, want %q", list[0].Label, "dev-server")
	}
	if list[0].Port != 9000 {
		t.Errorf("Port = %d, want 9000", list[0].Port)
	}
}

func TestRegistryPrefixForSessionPeerNotFound(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	prefix, ok := reg.PrefixForSessionPeer("session-a", "nonexistent")
	if ok || prefix != "" {
		t.Errorf("expected empty/false for nonexistent peer, got %q, %v", prefix, ok)
	}
}

func TestRegistryPrefixForSessionPeerWrongSession(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	conn, _ := reg.Register("peer-pfx", "session-real", "")

	prefix, ok := reg.PrefixForSessionPeer("session-wrong", conn.PeerID)
	if ok || prefix != "" {
		t.Errorf("expected empty/false for wrong session, got %q, %v", prefix, ok)
	}

	prefix, ok = reg.PrefixForSessionPeer("session-real", conn.PeerID)
	if !ok {
		t.Error("expected ok=true for correct session")
	}
	if prefix != conn.Prefix {
		t.Errorf("Prefix = %q, want %q", prefix, conn.Prefix)
	}
}

func TestRegistryPrefixForSessionPeerWithBaseURL(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "https://tunnel.example.com/")

	conn, _ := reg.Register("peer-burl", "session-b", "")

	prefix, ok := reg.PrefixForSessionPeer("session-b", "peer-burl")
	if !ok {
		t.Fatal("expected ok=true")
	}
	if !strings.HasPrefix(prefix, "https://tunnel.example.com/peer-burl/") {
		t.Errorf("Prefix = %q, expected base URL prefix", prefix)
	}
	if prefix != conn.Prefix {
		t.Errorf("PrefixForSessionPeer = %q, Register.Prefix = %q", prefix, conn.Prefix)
	}
}

func TestRegistryShutdownResetsCounters(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	for i := 0; i < 5; i++ {
		reg.Register(fmt.Sprintf("peer-s%d", i), "session-shut", "")
	}

	if reg.TunnelCount() != 5 {
		t.Fatalf("TunnelCount before shutdown = %d, want 5", reg.TunnelCount())
	}

	reg.Shutdown()

	if reg.TunnelCount() != 0 {
		t.Errorf("TunnelCount after shutdown = %d, want 0", reg.TunnelCount())
	}

	_, err := reg.Register("peer-after", "session-shut", "")
	if err != nil {
		t.Errorf("Register after shutdown should succeed: %v", err)
	}
	if reg.TunnelCount() != 1 {
		t.Errorf("TunnelCount after re-register = %d, want 1", reg.TunnelCount())
	}
}

func TestRegistryShutdownMultipleSessions(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	var channels []<-chan json.RawMessage

	for i := 0; i < 3; i++ {
		conn, _ := reg.Register(fmt.Sprintf("peer-ms%d", i), fmt.Sprintf("session-%d", i), "")
		_, ch, _ := conn.CreateRequest()
		channels = append(channels, ch)
	}

	reg.Shutdown()

	for i, ch := range channels {
		if _, ok := <-ch; ok {
			t.Errorf("channel %d should be closed after Shutdown", i)
		}
	}

	for i := 0; i < 3; i++ {
		list := reg.ListBySession(fmt.Sprintf("session-%d", i))
		if list != nil {
			t.Errorf("ListBySession session-%d after shutdown = %v", i, list)
		}
	}
}

func TestRegistryShutdownIdempotent(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	reg.Register("peer-idem", "session-i", "")
	reg.Shutdown()
	// Second shutdown should not panic.
	reg.Shutdown()

	if reg.TunnelCount() != 0 {
		t.Errorf("TunnelCount after double shutdown = %d", reg.TunnelCount())
	}
}

func TestRegistryAddBytesUnderLimit(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	conn, _ := reg.Register("peer-bytes", "session-b", "")

	if conn.BytesRelayed() != 0 {
		t.Errorf("initial BytesRelayed = %d, want 0", conn.BytesRelayed())
	}

	ok := conn.AddBytes(1000)
	if !ok {
		t.Error("AddBytes(1000) should return true (under limit)")
	}
	if conn.BytesRelayed() != 1000 {
		t.Errorf("BytesRelayed = %d, want 1000", conn.BytesRelayed())
	}

	ok = conn.AddBytes(2000)
	if !ok {
		t.Error("AddBytes(2000) should return true")
	}
	if conn.BytesRelayed() != 3000 {
		t.Errorf("BytesRelayed = %d, want 3000", conn.BytesRelayed())
	}
}

func TestRegistryAddBytesExceedsLimit(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	conn, _ := reg.Register("peer-over", "session-b", "")

	// Add exactly up to the limit.
	ok := conn.AddBytes(tunnel.MaxBytesPerTunnel)
	if !ok {
		t.Error("AddBytes at exactly the limit should return true")
	}

	// One more byte exceeds.
	ok = conn.AddBytes(1)
	if ok {
		t.Error("AddBytes past the limit should return false")
	}

	if conn.BytesRelayed() != tunnel.MaxBytesPerTunnel+1 {
		t.Errorf("BytesRelayed = %d, want %d", conn.BytesRelayed(), tunnel.MaxBytesPerTunnel+1)
	}
}

func TestRegistryAddBytesLargeChunk(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	conn, _ := reg.Register("peer-big", "session-b", "")

	ok := conn.AddBytes(tunnel.MaxBytesPerTunnel + 1)
	if ok {
		t.Error("single AddBytes exceeding limit should return false")
	}
}

func TestRegistryCreateRequestUniqueIDs(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	conn, _ := reg.Register("peer-uid", "session-u", "")

	ids := map[string]bool{}
	for i := 0; i < 10; i++ {
		id, _, err := conn.CreateRequest()
		if err != nil {
			t.Fatal(err)
		}
		if ids[id] {
			t.Errorf("duplicate request ID: %s", id)
		}
		ids[id] = true
	}
}

func TestRegistryDispatchResponseUnknownID(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	conn, _ := reg.Register("peer-unk", "session-u", "")

	// Should not panic.
	conn.DispatchResponse("nonexistent-id", json.RawMessage(`{}`))
}

func TestRegistryCompleteRequestUnknownID(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	conn, _ := reg.Register("peer-cunk", "session-u", "")

	// Should not panic.
	conn.CompleteRequest("nonexistent-id")
}

func TestRegistryCompleteRequestIdempotent(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	conn, _ := reg.Register("peer-cidem", "session-u", "")

	reqID, _, _ := conn.CreateRequest()
	conn.CompleteRequest(reqID)
	// Second complete should not panic.
	conn.CompleteRequest(reqID)
}

func TestRegistryDispatchMultipleMessages(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	conn, _ := reg.Register("peer-multi", "session-m", "")

	reqID, ch, _ := conn.CreateRequest()

	for i := 0; i < 5; i++ {
		msg := json.RawMessage(fmt.Sprintf(`{"chunk":%d}`, i))
		conn.DispatchResponse(reqID, msg)
	}

	for i := 0; i < 5; i++ {
		got := <-ch
		expected := fmt.Sprintf(`{"chunk":%d}`, i)
		if string(got) != expected {
			t.Errorf("chunk %d: got %s, want %s", i, got, expected)
		}
	}

	conn.CompleteRequest(reqID)
}

func TestRegistryAccessTokenValidation(t *testing.T) {
	tests := []struct {
		name     string
		token    string
		wantUsed bool
	}{
		{"empty", "", false},
		{"invalid base64", "not-valid-base64!!!", false},
		{"too short 16 bytes", base64.URLEncoding.EncodeToString(make([]byte, 16)), false},
		{"too long 32 bytes", base64.URLEncoding.EncodeToString(make([]byte, 32)), false},
		{"exact 24 bytes", base64.URLEncoding.EncodeToString(make([]byte, 24)), true},
	}

	for i, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg := tunnel.NewRegistry(5, 100, "")
			peerID := fmt.Sprintf("peer-at-%d", i)

			conn, err := reg.Register(peerID, "session-at", tt.token)
			if err != nil {
				t.Fatalf("Register failed: %v", err)
			}

			if tt.wantUsed {
				if conn.AccessToken != tt.token {
					t.Errorf("token should be used as-is: got %q, want %q", conn.AccessToken, tt.token)
				}
			} else {
				if tt.token != "" && conn.AccessToken == tt.token {
					t.Errorf("invalid token %q should not be used", tt.token)
				}
				if conn.AccessToken == "" {
					t.Error("server should generate a token when client token is invalid")
				}
				decoded, err := base64.URLEncoding.DecodeString(conn.AccessToken)
				if err != nil {
					t.Errorf("generated token is not valid base64url: %v", err)
				}
				if len(decoded) != 24 {
					t.Errorf("generated token decodes to %d bytes, want 24", len(decoded))
				}
			}

			reg.Unregister(peerID)
		})
	}
}

func TestRegistryConnectionsBySessionDuplicateIPs(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	reg.Register("peer-d1", "session-dup", "")
	reg.Register("peer-d2", "session-dup", "")

	reg.SetIP("peer-d1", "10.0.0.5")
	reg.SetIP("peer-d2", "10.0.0.5")

	conns := reg.ConnectionsBySession()
	if got := conns["session-dup"]; !reflect.DeepEqual(got, []string{"10.0.0.5"}) {
		t.Errorf("duplicate IPs not deduplicated: %v", got)
	}
}

func TestRegistryConcurrentRegisterUnregister(t *testing.T) {
	reg := tunnel.NewRegistry(100, 200, "")

	var wg sync.WaitGroup

	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			reg.Register(fmt.Sprintf("peer-c%d", i), "session-conc", "")
		}(i)
	}
	wg.Wait()

	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			reg.Unregister(fmt.Sprintf("peer-c%d", i))
		}(i)
	}
	wg.Wait()

	if reg.TunnelCount() != 0 {
		t.Errorf("TunnelCount after concurrent ops = %d, want 0", reg.TunnelCount())
	}
}

func TestRegistryPrefixContainsTokenAndPeerID(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	conn, _ := reg.Register("my-peer-id", "session-pfx", "")

	if !strings.Contains(conn.Prefix, "my-peer-id") {
		t.Errorf("Prefix %q should contain peerID", conn.Prefix)
	}
	if !strings.Contains(conn.Prefix, conn.AccessToken) {
		t.Errorf("Prefix %q should contain access token", conn.Prefix)
	}
	if !strings.HasSuffix(conn.Prefix, "/") {
		t.Errorf("Prefix %q should end with /", conn.Prefix)
	}
}

func TestRegistryRegisterAfterSessionLimitFreed(t *testing.T) {
	reg := tunnel.NewRegistry(2, 100, "")

	reg.Register("p1", "s1", "")
	reg.Register("p2", "s1", "")

	_, err := reg.Register("p3", "s1", "")
	if err == nil {
		t.Fatal("should be at per-session limit")
	}

	reg.Unregister("p1")
	reg.Unregister("p2")

	_, err = reg.Register("p3", "s1", "")
	if err != nil {
		t.Fatalf("Register after freeing both slots: %v", err)
	}
	_, err = reg.Register("p4", "s1", "")
	if err != nil {
		t.Fatalf("Register second slot after freeing both: %v", err)
	}
}

func TestRegistryTunnelCountTracking(t *testing.T) {
	reg := tunnel.NewRegistry(5, 100, "")

	if reg.TunnelCount() != 0 {
		t.Fatalf("initial count = %d", reg.TunnelCount())
	}

	reg.Register("p1", "s1", "")
	if reg.TunnelCount() != 1 {
		t.Fatalf("after 1 register = %d", reg.TunnelCount())
	}

	reg.Register("p2", "s2", "")
	if reg.TunnelCount() != 2 {
		t.Fatalf("after 2 registers = %d", reg.TunnelCount())
	}

	reg.Unregister("p1")
	if reg.TunnelCount() != 1 {
		t.Fatalf("after 1 unregister = %d", reg.TunnelCount())
	}

	reg.Unregister("p2")
	if reg.TunnelCount() != 0 {
		t.Fatalf("after all unregistered = %d", reg.TunnelCount())
	}
}
