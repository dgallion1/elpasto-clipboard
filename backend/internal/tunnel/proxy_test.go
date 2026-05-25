package tunnel_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"elpasto/backend/internal/tunnel"
)

func runProxy(t *testing.T, target string) (send chan []byte, recv chan []byte) {
	t.Helper()
	p, err := tunnel.NewProxy(target, "peer-test")
	if err != nil {
		t.Fatalf("NewProxy: %v", err)
	}

	sendCh := make(chan []byte, 64)
	recvCh := make(chan []byte, 64)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)

	sendFn := func(data []byte) error {
		sendCh <- data
		return nil
	}

	go p.Handle(ctx, "peer-test", sendFn, recvCh)
	return sendCh, recvCh
}

func readMsg(t *testing.T, ch <-chan []byte, wantType tunnel.MessageType) []byte {
	t.Helper()
	select {
	case raw := <-ch:
		mt, err := tunnel.DecodeType(raw)
		if err != nil {
			t.Fatalf("decode type: %v", err)
		}
		if mt != wantType {
			t.Fatalf("got message type %q, want %q\nraw: %s", mt, wantType, raw)
		}
		return raw
	case <-time.After(3 * time.Second):
		t.Fatalf("timeout waiting for %q message", wantType)
		return nil
	}
}

func TestProxySimpleGET(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("hello from backend"))
	}))
	defer backend.Close()

	sendCh, recvCh := runProxy(t, backend.URL)

	// Send a request
	reqRaw, _ := json.Marshal(tunnel.RequestMsg{
		Type:      tunnel.MsgRequest,
		RequestID: "req-1",
		Method:    "GET",
		URL:       "/",
		Headers:   map[string]string{},
	})
	recvCh <- reqRaw

	// Send request end (no body)
	endRaw, _ := json.Marshal(tunnel.RequestEndMsg{Type: tunnel.MsgRequestEnd, RequestID: "req-1"})
	recvCh <- endRaw

	// Expect response
	respRaw := readMsg(t, sendCh, tunnel.MsgResponse)
	var resp tunnel.ResponseMsg
	if err := json.Unmarshal(respRaw, &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Status != http.StatusOK {
		t.Errorf("status: got %d, want 200", resp.Status)
	}

	// Expect body
	bodyRaw := readMsg(t, sendCh, tunnel.MsgResponseBody)
	var body tunnel.ResponseBodyMsg
	if err := json.Unmarshal(bodyRaw, &body); err != nil {
		t.Fatal(err)
	}
	decoded, err := base64.StdEncoding.DecodeString(body.Data)
	if err != nil {
		t.Fatal(err)
	}
	if string(decoded) != "hello from backend" {
		t.Errorf("body: got %q, want %q", decoded, "hello from backend")
	}

	// Expect end
	readMsg(t, sendCh, tunnel.MsgResponseEnd)
}

func TestProxyHTMLRewriting(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`<html><head><title>Test</title></head><body><a href="/explorer">Go</a><img src="/logo.png"></body></html>`))
	}))
	defer backend.Close()

	sendCh, recvCh := runProxy(t, backend.URL)

	reqRaw, _ := json.Marshal(tunnel.RequestMsg{
		Type:      tunnel.MsgRequest,
		RequestID: "req-html",
		Method:    "GET",
		URL:       "/",
		Headers:   map[string]string{},
	})
	recvCh <- reqRaw
	endRaw, _ := json.Marshal(tunnel.RequestEndMsg{Type: tunnel.MsgRequestEnd, RequestID: "req-html"})
	recvCh <- endRaw

	readMsg(t, sendCh, tunnel.MsgResponse)

	bodyRaw := readMsg(t, sendCh, tunnel.MsgResponseBody)
	var body tunnel.ResponseBodyMsg
	if err := json.Unmarshal(bodyRaw, &body); err != nil {
		t.Fatal(err)
	}
	decoded, err := base64.StdEncoding.DecodeString(body.Data)
	if err != nil {
		t.Fatal(err)
	}
	html := string(decoded)

	// Check base tag was injected
	if !strings.Contains(html, `<base href="/tunnel/peer-test/">`) {
		t.Errorf("missing base tag in HTML:\n%s", html)
	}
	// Check absolute-path attributes were rewritten
	if !strings.Contains(html, `href="/tunnel/peer-test/explorer"`) {
		t.Errorf("href not rewritten in HTML:\n%s", html)
	}
	if !strings.Contains(html, `src="/tunnel/peer-test/logo.png"`) {
		t.Errorf("src not rewritten in HTML:\n%s", html)
	}
	// Check JS shim was injected
	if !strings.Contains(html, `window.fetch=function`) {
		t.Errorf("missing fetch shim in HTML:\n%s", html)
	}

	readMsg(t, sendCh, tunnel.MsgResponseEnd)
}

func TestProxyRedirectRewriting(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/dashboard", http.StatusTemporaryRedirect)
	}))
	defer backend.Close()

	sendCh, recvCh := runProxy(t, backend.URL)

	reqRaw, _ := json.Marshal(tunnel.RequestMsg{
		Type:      tunnel.MsgRequest,
		RequestID: "req-redir",
		Method:    "GET",
		URL:       "/",
		Headers:   map[string]string{},
	})
	recvCh <- reqRaw
	endRaw, _ := json.Marshal(tunnel.RequestEndMsg{Type: tunnel.MsgRequestEnd, RequestID: "req-redir"})
	recvCh <- endRaw

	respRaw := readMsg(t, sendCh, tunnel.MsgResponse)
	var resp tunnel.ResponseMsg
	if err := json.Unmarshal(respRaw, &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Status != http.StatusTemporaryRedirect {
		t.Errorf("status: got %d, want 307", resp.Status)
	}
	loc := resp.Headers["Location"]
	if loc != "/tunnel/peer-test/dashboard" {
		t.Errorf("Location header: got %q, want /tunnel/peer-test/dashboard", loc)
	}

	// Drain body and end messages
	readMsg(t, sendCh, tunnel.MsgResponseBody)
	readMsg(t, sendCh, tunnel.MsgResponseEnd)
}

func TestProxyPrefixDefault(t *testing.T) {
	p, err := tunnel.NewProxy("http://127.0.0.1:9999", "my-peer")
	if err != nil {
		t.Fatalf("NewProxy: %v", err)
	}
	want := "/tunnel/my-peer/"
	if got := p.Prefix(); got != want {
		t.Errorf("default prefix: got %q, want %q", got, want)
	}
}

func TestProxyPrefixCustom(t *testing.T) {
	p, err := tunnel.NewProxy("http://127.0.0.1:9999", "my-peer")
	if err != nil {
		t.Fatalf("NewProxy: %v", err)
	}
	p.SetPrefix("/custom/prefix/")
	if got := p.Prefix(); got != "/custom/prefix/" {
		t.Errorf("custom prefix: got %q, want /custom/prefix/", got)
	}
}

func TestProxyPrefixUsedInHTMLRewriting(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`<html><head></head><body><a href="/page">link</a></body></html>`))
	}))
	defer backend.Close()

	p, err := tunnel.NewProxy(backend.URL, "peer-abc")
	if err != nil {
		t.Fatalf("NewProxy: %v", err)
	}
	p.SetPrefix("/custom/route/")

	sendCh := make(chan []byte, 64)
	recvCh := make(chan []byte, 64)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	go p.Handle(ctx, "peer-abc", func(data []byte) error { sendCh <- data; return nil }, recvCh)

	reqRaw, _ := json.Marshal(tunnel.RequestMsg{
		Type: tunnel.MsgRequest, RequestID: "req-pfx", Method: "GET", URL: "/", Headers: map[string]string{},
	})
	recvCh <- reqRaw
	endRaw, _ := json.Marshal(tunnel.RequestEndMsg{Type: tunnel.MsgRequestEnd, RequestID: "req-pfx"})
	recvCh <- endRaw

	readMsg(t, sendCh, tunnel.MsgResponse)
	bodyRaw := readMsg(t, sendCh, tunnel.MsgResponseBody)
	var body tunnel.ResponseBodyMsg
	if err := json.Unmarshal(bodyRaw, &body); err != nil {
		t.Fatal(err)
	}
	decoded, _ := base64.StdEncoding.DecodeString(body.Data)
	html := string(decoded)

	if !strings.Contains(html, `<base href="/custom/route/">`) {
		t.Errorf("expected custom prefix in base tag, got:\n%s", html)
	}
	if strings.Contains(html, `/tunnel/peer-abc/`) {
		t.Errorf("default prefix should not appear in HTML after SetPrefix, got:\n%s", html)
	}

	readMsg(t, sendCh, tunnel.MsgResponseEnd)
}

func TestProxyStreamingNonHTML(t *testing.T) {
	// Serve 128 KiB of data — large enough to require multiple 32766-byte chunks.
	const dataSize = 128 * 1024
	data := make([]byte, dataSize)
	for i := range data {
		data[i] = byte(i % 251) // arbitrary non-zero fill
	}

	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}))
	defer backend.Close()

	sendCh, recvCh := runProxy(t, backend.URL)

	reqRaw, _ := json.Marshal(tunnel.RequestMsg{
		Type: tunnel.MsgRequest, RequestID: "req-stream", Method: "GET", URL: "/", Headers: map[string]string{},
	})
	recvCh <- reqRaw
	endRaw, _ := json.Marshal(tunnel.RequestEndMsg{Type: tunnel.MsgRequestEnd, RequestID: "req-stream"})
	recvCh <- endRaw

	readMsg(t, sendCh, tunnel.MsgResponse)

	// Collect all body chunks until MsgResponseEnd
	chunkCount := 0
	var reassembled []byte
	for {
		select {
		case raw := <-sendCh:
			mt, err := tunnel.DecodeType(raw)
			if err != nil {
				t.Fatalf("decode type: %v", err)
			}
			switch mt {
			case tunnel.MsgResponseBody:
				var bm tunnel.ResponseBodyMsg
				if err := json.Unmarshal(raw, &bm); err != nil {
					t.Fatalf("unmarshal body: %v", err)
				}
				chunk, err := base64.StdEncoding.DecodeString(bm.Data)
				if err != nil {
					t.Fatalf("base64 decode: %v", err)
				}
				reassembled = append(reassembled, chunk...)
				chunkCount++
			case tunnel.MsgResponseEnd:
				goto done
			default:
				t.Fatalf("unexpected message type %q", mt)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("timeout waiting for streaming response")
		}
	}
done:
	if chunkCount < 2 {
		t.Errorf("expected multiple chunks for 128 KiB response, got %d", chunkCount)
	}
	if len(reassembled) != dataSize {
		t.Errorf("reassembled size: got %d, want %d", len(reassembled), dataSize)
	}
	for i, b := range reassembled {
		if b != data[i] {
			t.Errorf("data mismatch at byte %d: got %d, want %d", i, b, data[i])
			break
		}
	}
}

func TestProxyBadTargetURL(t *testing.T) {
	_, err := tunnel.NewProxy("://invalid", "test")
	if err == nil {
		t.Error("expected error for invalid URL")
	}
}

// TestProxyHTMLContentLengthStripped — HTML responses must have Content-Length removed
// from the tunnel:response headers because HTML rewriting changes the body size.
func TestProxyHTMLContentLengthStripped(t *testing.T) {
	// The proxy strips Content-Length for HTML responses because rewriting adds bytes.
	// We verify this by checking the tunnel:response headers.
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := []byte(`<html><head><title>Test</title></head><body><p>Hello</p></body></html>`)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		// Explicitly set Content-Length — the proxy must strip it for HTML.
		w.Header().Set("Content-Length", fmt.Sprintf("%d", len(body)))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(body)
	}))
	defer backend.Close()

	sendCh, recvCh := runProxy(t, backend.URL)

	reqRaw, _ := json.Marshal(tunnel.RequestMsg{
		Type:      tunnel.MsgRequest,
		RequestID: "req-cl",
		Method:    "GET",
		URL:       "/",
		Headers:   map[string]string{},
	})
	recvCh <- reqRaw
	endRaw, _ := json.Marshal(tunnel.RequestEndMsg{Type: tunnel.MsgRequestEnd, RequestID: "req-cl"})
	recvCh <- endRaw

	respRaw := readMsg(t, sendCh, tunnel.MsgResponse)
	var resp tunnel.ResponseMsg
	if err := json.Unmarshal(respRaw, &resp); err != nil {
		t.Fatal(err)
	}

	// Content-Length must be absent from forwarded headers for HTML responses.
	for k := range resp.Headers {
		if strings.EqualFold(k, "Content-Length") {
			t.Errorf("Content-Length should be stripped from HTML tunnel:response headers")
		}
	}

	// Drain remaining messages — body (may be one or more) and end.
	for {
		select {
		case raw := <-sendCh:
			mt, err := tunnel.DecodeType(raw)
			if err != nil {
				t.Fatalf("decode type: %v", err)
			}
			if mt == tunnel.MsgResponseEnd {
				return
			}
		case <-time.After(3 * time.Second):
			t.Fatal("timeout draining HTML response")
		}
	}
}

// TestProxyContextCancellation — cancelling the context while waiting for request-end
// causes the proxy goroutine to send a tunnel:error and return without hanging.
func TestProxyContextCancellation(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()

	p, err := tunnel.NewProxy(backend.URL, "peer-cancel")
	if err != nil {
		t.Fatalf("NewProxy: %v", err)
	}

	sendCh := make(chan []byte, 64)
	recvCh := make(chan []byte, 1) // small buffer — we won't send request-end

	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan struct{})
	go func() {
		defer close(done)
		p.Handle(ctx, "peer-cancel", func(data []byte) error { sendCh <- data; return nil }, recvCh)
	}()

	// Send a tunnel:request but NOT the request-end, so Handle blocks in the body-reading loop.
	reqRaw, _ := json.Marshal(tunnel.RequestMsg{
		Type:      tunnel.MsgRequest,
		RequestID: "req-cancel",
		Method:    "GET",
		URL:       "/",
		Headers:   map[string]string{},
	})
	recvCh <- reqRaw

	// Give the goroutine time to start processing the request.
	time.Sleep(50 * time.Millisecond)

	// Cancel the context — the proxy should stop waiting for request-end and return.
	cancel()

	select {
	case <-done:
		// Handle returned — good.
	case <-time.After(3 * time.Second):
		t.Error("Handle did not return after context cancellation")
	}
}

// TestProxyBodyDecodeError — send a tunnel:request-body with invalid base64 data.
// The proxy should respond with a tunnel:error message.
func TestProxyBodyDecodeError(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()

	sendCh, recvCh := runProxy(t, backend.URL)

	// Send a POST request.
	reqRaw, _ := json.Marshal(tunnel.RequestMsg{
		Type:      tunnel.MsgRequest,
		RequestID: "req-bad-body",
		Method:    "POST",
		URL:       "/upload",
		Headers:   map[string]string{},
	})
	recvCh <- reqRaw

	// Send a body chunk with invalid base64 data.
	bodyRaw, _ := json.Marshal(tunnel.RequestBodyMsg{
		Type:      tunnel.MsgRequestBody,
		RequestID: "req-bad-body",
		Data:      "!!!not valid base64!!!",
	})
	recvCh <- bodyRaw

	// Send request-end to terminate the body loop.
	endRaw, _ := json.Marshal(tunnel.RequestEndMsg{Type: tunnel.MsgRequestEnd, RequestID: "req-bad-body"})
	recvCh <- endRaw

	// Expect a tunnel:error response.
	errRaw := readMsg(t, sendCh, tunnel.MsgError)
	var errMsg tunnel.ErrorMsg
	if err := json.Unmarshal(errRaw, &errMsg); err != nil {
		t.Fatal(err)
	}
	if errMsg.RequestID != "req-bad-body" {
		t.Errorf("requestId: got %q, want req-bad-body", errMsg.RequestID)
	}
	if !strings.Contains(errMsg.Message, "body decode error") {
		t.Errorf("error message: got %q, want to contain 'body decode error'", errMsg.Message)
	}
}

func TestProxyConnectionRefused(t *testing.T) {
	// Use a port that is certainly not listening
	sendCh, recvCh := runProxy(t, "http://127.0.0.1:19999")

	reqRaw, _ := json.Marshal(tunnel.RequestMsg{
		Type:      tunnel.MsgRequest,
		RequestID: "req-fail",
		Method:    "GET",
		URL:       "/",
		Headers:   map[string]string{},
	})
	recvCh <- reqRaw
	endRaw, _ := json.Marshal(tunnel.RequestEndMsg{Type: tunnel.MsgRequestEnd, RequestID: "req-fail"})
	recvCh <- endRaw

	errRaw := readMsg(t, sendCh, tunnel.MsgError)
	var errMsg tunnel.ErrorMsg
	if err := json.Unmarshal(errRaw, &errMsg); err != nil {
		t.Fatal(err)
	}
	if errMsg.RequestID != "req-fail" {
		t.Errorf("requestId: got %q, want req-fail", errMsg.RequestID)
	}
}

// TestProxyHTMLFallbackBeforeHeadClose verifies that when HTML has </head> but no
// <head>, the rewriter injects before </head>.
func TestProxyHTMLFallbackBeforeHeadClose(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusOK)
		// HTML with </head> but no <head> opening tag
		_, _ = w.Write([]byte(`<html></head><body><a href="/page">link</a></body></html>`))
	}))
	defer backend.Close()

	sendCh, recvCh := runProxy(t, backend.URL)

	reqRaw, _ := json.Marshal(tunnel.RequestMsg{
		Type: tunnel.MsgRequest, RequestID: "req-nohead", Method: "GET", URL: "/", Headers: map[string]string{},
	})
	recvCh <- reqRaw
	endRaw, _ := json.Marshal(tunnel.RequestEndMsg{Type: tunnel.MsgRequestEnd, RequestID: "req-nohead"})
	recvCh <- endRaw

	readMsg(t, sendCh, tunnel.MsgResponse)
	bodyRaw := readMsg(t, sendCh, tunnel.MsgResponseBody)
	var body tunnel.ResponseBodyMsg
	if err := json.Unmarshal(bodyRaw, &body); err != nil {
		t.Fatal(err)
	}
	decoded, _ := base64.StdEncoding.DecodeString(body.Data)
	html := string(decoded)

	// Should inject before </head>
	if !strings.Contains(html, `<base href="/tunnel/peer-test/">`) {
		t.Errorf("missing base tag injection before </head>:\n%s", html)
	}
	readMsg(t, sendCh, tunnel.MsgResponseEnd)
}

// TestProxyHTMLNoHeadTag verifies that when HTML has neither <head> nor </head>,
// the body is returned unmodified (no injection).
func TestProxyHTMLNoHeadTag(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`<html><body><p>no head</p></body></html>`))
	}))
	defer backend.Close()

	sendCh, recvCh := runProxy(t, backend.URL)

	reqRaw, _ := json.Marshal(tunnel.RequestMsg{
		Type: tunnel.MsgRequest, RequestID: "req-nohead2", Method: "GET", URL: "/", Headers: map[string]string{},
	})
	recvCh <- reqRaw
	endRaw, _ := json.Marshal(tunnel.RequestEndMsg{Type: tunnel.MsgRequestEnd, RequestID: "req-nohead2"})
	recvCh <- endRaw

	readMsg(t, sendCh, tunnel.MsgResponse)
	bodyRaw := readMsg(t, sendCh, tunnel.MsgResponseBody)
	var body tunnel.ResponseBodyMsg
	if err := json.Unmarshal(bodyRaw, &body); err != nil {
		t.Fatal(err)
	}
	decoded, _ := base64.StdEncoding.DecodeString(body.Data)
	html := string(decoded)

	// Should NOT inject base tag since there's no <head> or </head>
	if strings.Contains(html, `<base href=`) {
		t.Errorf("should not inject base tag when no head element exists:\n%s", html)
	}
	readMsg(t, sendCh, tunnel.MsgResponseEnd)
}

// TestProxyRewriteActionAttribute verifies that action="/submit" in forms is rewritten.
func TestProxyRewriteActionAttribute(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`<html><head></head><body><form action="/submit"><input type="submit"></form></body></html>`))
	}))
	defer backend.Close()

	sendCh, recvCh := runProxy(t, backend.URL)

	reqRaw, _ := json.Marshal(tunnel.RequestMsg{
		Type: tunnel.MsgRequest, RequestID: "req-action", Method: "GET", URL: "/", Headers: map[string]string{},
	})
	recvCh <- reqRaw
	endRaw, _ := json.Marshal(tunnel.RequestEndMsg{Type: tunnel.MsgRequestEnd, RequestID: "req-action"})
	recvCh <- endRaw

	readMsg(t, sendCh, tunnel.MsgResponse)
	bodyRaw := readMsg(t, sendCh, tunnel.MsgResponseBody)
	var body tunnel.ResponseBodyMsg
	if err := json.Unmarshal(bodyRaw, &body); err != nil {
		t.Fatal(err)
	}
	decoded, _ := base64.StdEncoding.DecodeString(body.Data)
	html := string(decoded)

	if !strings.Contains(html, `action="/tunnel/peer-test/submit"`) {
		t.Errorf("action attribute not rewritten:\n%s", html)
	}
	readMsg(t, sendCh, tunnel.MsgResponseEnd)
}

// TestProxyRewriteSkipsAlreadyPrefixed verifies that URLs already under the tunnel
// prefix are not double-rewritten.
func TestProxyRewriteSkipsAlreadyPrefixed(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`<html><head></head><body><a href="/tunnel/peer-test/already">link</a></body></html>`))
	}))
	defer backend.Close()

	sendCh, recvCh := runProxy(t, backend.URL)

	reqRaw, _ := json.Marshal(tunnel.RequestMsg{
		Type: tunnel.MsgRequest, RequestID: "req-norewrite", Method: "GET", URL: "/", Headers: map[string]string{},
	})
	recvCh <- reqRaw
	endRaw, _ := json.Marshal(tunnel.RequestEndMsg{Type: tunnel.MsgRequestEnd, RequestID: "req-norewrite"})
	recvCh <- endRaw

	readMsg(t, sendCh, tunnel.MsgResponse)
	bodyRaw := readMsg(t, sendCh, tunnel.MsgResponseBody)
	var body tunnel.ResponseBodyMsg
	if err := json.Unmarshal(bodyRaw, &body); err != nil {
		t.Fatal(err)
	}
	decoded, _ := base64.StdEncoding.DecodeString(body.Data)
	html := string(decoded)

	// Should appear exactly once, not double-prefixed
	count := strings.Count(html, "/tunnel/peer-test/already")
	if count != 1 {
		t.Errorf("expected href to appear exactly once (no double-rewrite), found %d times:\n%s", count, html)
	}
	readMsg(t, sendCh, tunnel.MsgResponseEnd)
}

// TestProxyHandleMalformedJSON verifies that sending invalid JSON to Handle is
// silently skipped without breaking the proxy loop.
func TestProxyHandleMalformedJSON(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer backend.Close()

	p, err := tunnel.NewProxy(backend.URL, "peer-malformed")
	if err != nil {
		t.Fatalf("NewProxy: %v", err)
	}

	sendCh := make(chan []byte, 64)
	recvCh := make(chan []byte, 64)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	go p.Handle(ctx, "peer-malformed", func(data []byte) error { sendCh <- data; return nil }, recvCh)

	// Send malformed JSON — should be silently skipped.
	recvCh <- []byte("not valid json {{{")

	// Send a valid request afterward to prove the loop still works.
	reqRaw, _ := json.Marshal(tunnel.RequestMsg{
		Type: tunnel.MsgRequest, RequestID: "req-after-bad", Method: "GET", URL: "/", Headers: map[string]string{},
	})
	recvCh <- reqRaw
	endRaw, _ := json.Marshal(tunnel.RequestEndMsg{Type: tunnel.MsgRequestEnd, RequestID: "req-after-bad"})
	recvCh <- endRaw

	readMsg(t, sendCh, tunnel.MsgResponse)
	readMsg(t, sendCh, tunnel.MsgResponseBody)
	readMsg(t, sendCh, tunnel.MsgResponseEnd)
}

// TestProxyConcurrentRequestLimit verifies that exceeding MaxConcurrentRequests
// returns a tunnel:error message with "too many concurrent requests".
func TestProxyConcurrentRequestLimit(t *testing.T) {
	// Backend that blocks forever, keeping request slots occupied.
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Block until the request is cancelled.
		<-r.Context().Done()
	}))
	defer backend.Close()

	p, err := tunnel.NewProxy(backend.URL, "peer-conc")
	if err != nil {
		t.Fatalf("NewProxy: %v", err)
	}

	sendCh := make(chan []byte, 256)
	recvCh := make(chan []byte, 256)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	go p.Handle(ctx, "peer-conc", func(data []byte) error { sendCh <- data; return nil }, recvCh)

	// Fill up all slots with blocking requests (each needs request + request-end).
	for i := 0; i < tunnel.MaxConcurrentRequests; i++ {
		reqRaw, _ := json.Marshal(tunnel.RequestMsg{
			Type:      tunnel.MsgRequest,
			RequestID: fmt.Sprintf("req-fill-%d", i),
			Method:    "GET",
			URL:       "/block",
			Headers:   map[string]string{},
		})
		recvCh <- reqRaw
		endRaw, _ := json.Marshal(tunnel.RequestEndMsg{
			Type:      tunnel.MsgRequestEnd,
			RequestID: fmt.Sprintf("req-fill-%d", i),
		})
		recvCh <- endRaw
	}

	// Give goroutines time to start and occupy the semaphore.
	time.Sleep(100 * time.Millisecond)

	// Send one more request — should be rejected.
	overflowReq, _ := json.Marshal(tunnel.RequestMsg{
		Type:      tunnel.MsgRequest,
		RequestID: "req-overflow",
		Method:    "GET",
		URL:       "/overflow",
		Headers:   map[string]string{},
	})
	recvCh <- overflowReq

	// Should receive a tunnel:error for the overflow request.
	errRaw := readMsg(t, sendCh, tunnel.MsgError)
	var errMsg tunnel.ErrorMsg
	if err := json.Unmarshal(errRaw, &errMsg); err != nil {
		t.Fatal(err)
	}
	if errMsg.RequestID != "req-overflow" {
		t.Errorf("requestId: got %q, want req-overflow", errMsg.RequestID)
	}
	if !strings.Contains(errMsg.Message, "too many concurrent requests") {
		t.Errorf("error message: got %q, want to contain 'too many concurrent requests'", errMsg.Message)
	}
}

// TestProxySendErrorDuringResponse verifies that when the send function returns
// an error during response streaming, the proxy goroutine exits cleanly.
func TestProxySendErrorDuringResponse(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("hello"))
	}))
	defer backend.Close()

	p, err := tunnel.NewProxy(backend.URL, "peer-sendfail")
	if err != nil {
		t.Fatalf("NewProxy: %v", err)
	}

	callCount := 0
	recvCh := make(chan []byte, 64)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		p.Handle(ctx, "peer-sendfail", func(data []byte) error {
			callCount++
			if callCount == 1 {
				// First call is the tunnel:response header — fail it.
				return fmt.Errorf("simulated send error")
			}
			return nil
		}, recvCh)
	}()

	reqRaw, _ := json.Marshal(tunnel.RequestMsg{
		Type: tunnel.MsgRequest, RequestID: "req-sendfail", Method: "GET", URL: "/", Headers: map[string]string{},
	})
	recvCh <- reqRaw
	endRaw, _ := json.Marshal(tunnel.RequestEndMsg{Type: tunnel.MsgRequestEnd, RequestID: "req-sendfail"})
	recvCh <- endRaw

	// Give time for processing, then close recv to end Handle.
	time.Sleep(200 * time.Millisecond)
	cancel()

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Error("Handle did not return after send error")
	}
}

// TestProxyRedirectAlreadyPrefixed verifies that a redirect Location header
// already starting with the tunnel prefix is not double-rewritten.
func TestProxyRedirectAlreadyPrefixed(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Redirect to a path already under the tunnel prefix
		w.Header().Set("Location", "/tunnel/peer-test/already")
		w.WriteHeader(http.StatusTemporaryRedirect)
	}))
	defer backend.Close()

	sendCh, recvCh := runProxy(t, backend.URL)

	reqRaw, _ := json.Marshal(tunnel.RequestMsg{
		Type: tunnel.MsgRequest, RequestID: "req-redir-pfx", Method: "GET", URL: "/", Headers: map[string]string{},
	})
	recvCh <- reqRaw
	endRaw, _ := json.Marshal(tunnel.RequestEndMsg{Type: tunnel.MsgRequestEnd, RequestID: "req-redir-pfx"})
	recvCh <- endRaw

	respRaw := readMsg(t, sendCh, tunnel.MsgResponse)
	var resp tunnel.ResponseMsg
	if err := json.Unmarshal(respRaw, &resp); err != nil {
		t.Fatal(err)
	}
	loc := resp.Headers["Location"]
	// Should not be double-prefixed
	if loc != "/tunnel/peer-test/already" {
		t.Errorf("Location: got %q, should not be double-prefixed", loc)
	}

	// Drain remaining messages.
	for {
		select {
		case raw := <-sendCh:
			mt, _ := tunnel.DecodeType(raw)
			if mt == tunnel.MsgResponseEnd {
				return
			}
		case <-time.After(3 * time.Second):
			t.Fatal("timeout draining response")
		}
	}
}

// TestProxyPOSTWithBody verifies that a POST request with a base64-encoded body
// is correctly forwarded to the backend.
func TestProxyPOSTWithBody(t *testing.T) {
	var receivedBody string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		receivedBody = string(body)
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("received"))
	}))
	defer backend.Close()

	sendCh, recvCh := runProxy(t, backend.URL)

	reqRaw, _ := json.Marshal(tunnel.RequestMsg{
		Type: tunnel.MsgRequest, RequestID: "req-post", Method: "POST", URL: "/submit", Headers: map[string]string{"Content-Type": "text/plain"},
	})
	recvCh <- reqRaw

	bodyData := base64.StdEncoding.EncodeToString([]byte("hello post body"))
	bodyRaw, _ := json.Marshal(tunnel.RequestBodyMsg{
		Type: tunnel.MsgRequestBody, RequestID: "req-post", Data: bodyData,
	})
	recvCh <- bodyRaw

	endRaw, _ := json.Marshal(tunnel.RequestEndMsg{Type: tunnel.MsgRequestEnd, RequestID: "req-post"})
	recvCh <- endRaw

	readMsg(t, sendCh, tunnel.MsgResponse)
	readMsg(t, sendCh, tunnel.MsgResponseBody)
	readMsg(t, sendCh, tunnel.MsgResponseEnd)

	if receivedBody != "hello post body" {
		t.Errorf("backend received body %q, want %q", receivedBody, "hello post body")
	}
}

// TestProxyRecvClosedDuringBodyCollect verifies that when the recv channel is
// closed while collecting body chunks, the proxy handles it gracefully.
func TestProxyRecvClosedDuringBodyCollect(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()

	p, err := tunnel.NewProxy(backend.URL, "peer-close")
	if err != nil {
		t.Fatalf("NewProxy: %v", err)
	}

	sendCh := make(chan []byte, 64)
	recvCh := make(chan []byte, 64)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		p.Handle(ctx, "peer-close", func(data []byte) error { sendCh <- data; return nil }, recvCh)
	}()

	// Send request but then close recv without sending request-end.
	reqRaw, _ := json.Marshal(tunnel.RequestMsg{
		Type: tunnel.MsgRequest, RequestID: "req-close", Method: "POST", URL: "/upload", Headers: map[string]string{},
	})
	recvCh <- reqRaw

	// Give the goroutine time to start body collection.
	time.Sleep(50 * time.Millisecond)

	// Close the recv channel — simulates peer disconnect.
	close(recvCh)

	select {
	case <-done:
		// Handle returned cleanly — good.
	case <-time.After(5 * time.Second):
		t.Error("Handle did not return after recv channel closed")
	}
}

// TestProxyNonHTMLContentLengthPreserved verifies that non-HTML responses
// preserve their Content-Length header (unlike HTML where it's stripped).
func TestProxyNonHTMLContentLengthPreserved(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := []byte("plain text response")
		w.Header().Set("Content-Type", "text/plain")
		w.Header().Set("Content-Length", fmt.Sprintf("%d", len(body)))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(body)
	}))
	defer backend.Close()

	sendCh, recvCh := runProxy(t, backend.URL)

	reqRaw, _ := json.Marshal(tunnel.RequestMsg{
		Type: tunnel.MsgRequest, RequestID: "req-cl-plain", Method: "GET", URL: "/", Headers: map[string]string{},
	})
	recvCh <- reqRaw
	endRaw, _ := json.Marshal(tunnel.RequestEndMsg{Type: tunnel.MsgRequestEnd, RequestID: "req-cl-plain"})
	recvCh <- endRaw

	respRaw := readMsg(t, sendCh, tunnel.MsgResponse)
	var resp tunnel.ResponseMsg
	if err := json.Unmarshal(respRaw, &resp); err != nil {
		t.Fatal(err)
	}

	// Content-Length should be present for non-HTML responses.
	clFound := false
	for k := range resp.Headers {
		if strings.EqualFold(k, "Content-Length") {
			clFound = true
			break
		}
	}
	if !clFound {
		t.Error("Content-Length should be preserved for non-HTML responses")
	}

	// Drain remaining messages.
	for {
		select {
		case raw := <-sendCh:
			mt, _ := tunnel.DecodeType(raw)
			if mt == tunnel.MsgResponseEnd {
				return
			}
		case <-time.After(3 * time.Second):
			t.Fatal("timeout draining response")
		}
	}
}

// TestProxyInvalidRequestURL verifies that an invalid URL in the tunnel:request
// returns an error response.
func TestProxyInvalidRequestURL(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	defer srv.Close()

	sendCh, recvCh := runProxy(t, srv.URL)

	// Send a request with an unparseable URL.
	reqMsg, _ := tunnel.Encode(tunnel.RequestMsg{
		Type:      tunnel.MsgRequest,
		RequestID: "invalid-url-test",
		Method:    "GET",
		URL:       "://invalid-url",
	})
	recvCh <- reqMsg

	endMsg, _ := tunnel.Encode(tunnel.RequestEndMsg{
		Type:      tunnel.MsgRequestEnd,
		RequestID: "invalid-url-test",
	})
	recvCh <- endMsg

	// Should get a tunnel:error response.
	raw := readMsg(t, sendCh, tunnel.MsgError)
	var errMsg tunnel.ErrorMsg
	if err := json.Unmarshal(raw, &errMsg); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}
	if !strings.Contains(errMsg.Message, "invalid") {
		t.Errorf("error message = %q, expected to contain 'invalid'", errMsg.Message)
	}
}

// TestProxyRequestBodyDecodeError verifies that invalid base64 body data
// returns an error response.
func TestProxyRequestBodyDecodeError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	defer srv.Close()

	sendCh, recvCh := runProxy(t, srv.URL)

	// Send a request.
	reqMsg, _ := tunnel.Encode(tunnel.RequestMsg{
		Type:      tunnel.MsgRequest,
		RequestID: "body-decode-test",
		Method:    "POST",
		URL:       "/test",
	})
	recvCh <- reqMsg

	// Send body with invalid base64.
	bodyMsg, _ := json.Marshal(tunnel.RequestBodyMsg{
		Type:      tunnel.MsgRequestBody,
		RequestID: "body-decode-test",
		Data:      "!!!not-valid-base64!!!",
	})
	recvCh <- bodyMsg

	endMsg, _ := tunnel.Encode(tunnel.RequestEndMsg{
		Type:      tunnel.MsgRequestEnd,
		RequestID: "body-decode-test",
	})
	recvCh <- endMsg

	// Should get a tunnel:error response.
	raw := readMsg(t, sendCh, tunnel.MsgError)
	var errMsg tunnel.ErrorMsg
	if err := json.Unmarshal(raw, &errMsg); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}
	if !strings.Contains(errMsg.Message, "body decode") {
		t.Errorf("error message = %q, expected to contain 'body decode'", errMsg.Message)
	}
}

// TestProxyTargetUnreachable verifies that when the target server is not running,
// the proxy returns an error response.
func TestProxyTargetUnreachable(t *testing.T) {
	sendCh, recvCh := runProxy(t, "http://127.0.0.1:1")

	reqMsg, _ := tunnel.Encode(tunnel.RequestMsg{
		Type:      tunnel.MsgRequest,
		RequestID: "unreachable-test",
		Method:    "GET",
		URL:       "/test",
	})
	recvCh <- reqMsg

	endMsg, _ := tunnel.Encode(tunnel.RequestEndMsg{
		Type:      tunnel.MsgRequestEnd,
		RequestID: "unreachable-test",
	})
	recvCh <- endMsg

	// Should get a tunnel:error response.
	raw := readMsg(t, sendCh, tunnel.MsgError)
	var errMsg tunnel.ErrorMsg
	if err := json.Unmarshal(raw, &errMsg); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}
	if !strings.Contains(errMsg.Message, "proxy request") {
		t.Errorf("error message = %q, expected to contain 'proxy request'", errMsg.Message)
	}
}

// TestProxyWithRequestBody verifies that POST body data is correctly forwarded.
func TestProxyWithRequestBody(t *testing.T) {
	var receivedBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		receivedBody = string(body)
		w.WriteHeader(200)
		w.Write([]byte("ok"))
	}))
	defer srv.Close()

	sendCh, recvCh := runProxy(t, srv.URL)

	reqMsg, _ := tunnel.Encode(tunnel.RequestMsg{
		Type:      tunnel.MsgRequest,
		RequestID: "post-body-test",
		Method:    "POST",
		URL:       "/submit",
		Headers:   map[string]string{"Content-Type": "text/plain"},
	})
	recvCh <- reqMsg

	bodyData := base64.StdEncoding.EncodeToString([]byte("hello world"))
	bodyMsg, _ := json.Marshal(tunnel.RequestBodyMsg{
		Type:      tunnel.MsgRequestBody,
		RequestID: "post-body-test",
		Data:      bodyData,
	})
	recvCh <- bodyMsg

	endMsg, _ := tunnel.Encode(tunnel.RequestEndMsg{
		Type:      tunnel.MsgRequestEnd,
		RequestID: "post-body-test",
	})
	recvCh <- endMsg

	// Read response.
	_ = readMsg(t, sendCh, tunnel.MsgResponse)

	// Drain to response-end.
	for {
		select {
		case raw := <-sendCh:
			mt, _ := tunnel.DecodeType(raw)
			if mt == tunnel.MsgResponseEnd {
				goto done
			}
		case <-time.After(3 * time.Second):
			t.Fatal("timeout")
		}
	}
done:
	if receivedBody != "hello world" {
		t.Errorf("received body = %q, want %q", receivedBody, "hello world")
	}
}

// TestProxyHandleMalformedMessages verifies that the Handle function ignores
// malformed messages (invalid JSON, unknown types) without crashing.
func TestProxyHandleMalformedMessages(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		w.Write([]byte("ok"))
	}))
	defer srv.Close()

	sendCh, recvCh := runProxy(t, srv.URL)

	// Send invalid JSON — should be silently ignored.
	recvCh <- []byte("not valid json at all {{{")

	// Send a message with unknown type — should be silently ignored.
	recvCh <- []byte(`{"type":"unknown:type","requestId":"test"}`)

	// Now send a valid request to prove the handler is still alive.
	reqMsg, _ := tunnel.Encode(tunnel.RequestMsg{
		Type:      tunnel.MsgRequest,
		RequestID: "after-malformed",
		Method:    "GET",
		URL:       "/test",
	})
	recvCh <- reqMsg

	endMsg, _ := tunnel.Encode(tunnel.RequestEndMsg{
		Type:      tunnel.MsgRequestEnd,
		RequestID: "after-malformed",
	})
	recvCh <- endMsg

	// Should get a valid response.
	_ = readMsg(t, sendCh, tunnel.MsgResponse)

	// Drain to response-end.
	for {
		select {
		case raw := <-sendCh:
			mt, _ := tunnel.DecodeType(raw)
			if mt == tunnel.MsgResponseEnd {
				return
			}
		case <-time.After(3 * time.Second):
			t.Fatal("timeout")
		}
	}
}

// TestProxyHandleContextCancel verifies that cancelling the context
// causes Handle to exit cleanly.
func TestProxyHandleContextCancel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	defer srv.Close()

	p, err := tunnel.NewProxy(srv.URL, "peer-test")
	if err != nil {
		t.Fatalf("NewProxy: %v", err)
	}

	sendCh := make(chan []byte, 64)
	recvCh := make(chan []byte, 64)

	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan struct{})
	go func() {
		defer close(done)
		p.Handle(ctx, "peer-test", func(data []byte) error {
			sendCh <- data
			return nil
		}, recvCh)
	}()

	// Cancel the context — Handle should exit.
	cancel()

	select {
	case <-done:
		// Good — Handle exited.
	case <-time.After(3 * time.Second):
		t.Fatal("Handle did not exit after context cancel")
	}
}

// TestProxyHandleRecvClosed verifies that closing the recv channel
// causes Handle to exit cleanly.
func TestProxyHandleRecvClosed(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	defer srv.Close()

	p, err := tunnel.NewProxy(srv.URL, "peer-test")
	if err != nil {
		t.Fatalf("NewProxy: %v", err)
	}

	sendCh := make(chan []byte, 64)
	recvCh := make(chan []byte, 64)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		p.Handle(ctx, "peer-test", func(data []byte) error {
			sendCh <- data
			return nil
		}, recvCh)
	}()

	// Close the recv channel — Handle should exit.
	close(recvCh)

	select {
	case <-done:
		// Good — Handle exited.
	case <-time.After(3 * time.Second):
		t.Fatal("Handle did not exit after recv channel closed")
	}
}

// TestProxyRedirectLocationRewrite verifies that Location headers in redirect
// responses are rewritten to go through the tunnel prefix.
func TestProxyRedirectLocationRewrite(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", "/login?redirect=/dashboard")
		w.WriteHeader(302)
	}))
	defer srv.Close()

	p, err := tunnel.NewProxy(srv.URL, "peer-test")
	if err != nil {
		t.Fatalf("NewProxy: %v", err)
	}
	p.SetPrefix("/tunnel/peer-test/token/")

	sendCh := make(chan []byte, 64)
	recvCh := make(chan []byte, 64)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	sendFn := func(data []byte) error {
		sendCh <- data
		return nil
	}
	go p.Handle(ctx, "peer-test", sendFn, recvCh)

	reqMsg, _ := tunnel.Encode(tunnel.RequestMsg{
		Type:      tunnel.MsgRequest,
		RequestID: "redirect-test",
		Method:    "GET",
		URL:       "/protected",
	})
	recvCh <- reqMsg

	endMsg, _ := tunnel.Encode(tunnel.RequestEndMsg{
		Type:      tunnel.MsgRequestEnd,
		RequestID: "redirect-test",
	})
	recvCh <- endMsg

	// Read response.
	raw := readMsg(t, sendCh, tunnel.MsgResponse)
	var resp tunnel.ResponseMsg
	if err := json.Unmarshal(raw, &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	loc, ok := resp.Headers["Location"]
	if !ok {
		t.Fatal("expected Location header in response")
	}
	if !strings.HasPrefix(loc, "/tunnel/peer-test/token/") {
		t.Errorf("Location = %q, expected to start with tunnel prefix", loc)
	}
}

// TestProxyBodyMsgForUnknownRequest verifies that a MsgRequestBody for a
// request ID not in the inflight map is silently ignored.
func TestProxyBodyMsgForUnknownRequest(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer backend.Close()

	p, err := tunnel.NewProxy(backend.URL, "peer-unk")
	if err != nil {
		t.Fatalf("NewProxy: %v", err)
	}

	sendCh := make(chan []byte, 64)
	recvCh := make(chan []byte, 64)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	go p.Handle(ctx, "peer-unk", func(data []byte) error { sendCh <- data; return nil }, recvCh)

	// Send a body message for a request ID that doesn't exist — should be silently ignored.
	bodyMsg, _ := json.Marshal(tunnel.RequestBodyMsg{
		Type:      tunnel.MsgRequestBody,
		RequestID: "nonexistent-req",
		Data:      "aGVsbG8=",
	})
	recvCh <- bodyMsg

	// Send a request-end for a request ID that doesn't exist — also silently ignored.
	endMsg, _ := json.Marshal(tunnel.RequestEndMsg{
		Type:      tunnel.MsgRequestEnd,
		RequestID: "nonexistent-req",
	})
	recvCh <- endMsg

	// Now send a valid request to prove the proxy loop survived.
	reqRaw, _ := json.Marshal(tunnel.RequestMsg{
		Type: tunnel.MsgRequest, RequestID: "real-req", Method: "GET", URL: "/", Headers: map[string]string{},
	})
	recvCh <- reqRaw
	endRaw, _ := json.Marshal(tunnel.RequestEndMsg{Type: tunnel.MsgRequestEnd, RequestID: "real-req"})
	recvCh <- endRaw

	readMsg(t, sendCh, tunnel.MsgResponse)
	readMsg(t, sendCh, tunnel.MsgResponseBody)
	readMsg(t, sendCh, tunnel.MsgResponseEnd)
}

// TestProxySendErrorDuringBodyChunk verifies that when the send function
// returns an error during a body chunk, the proxy goroutine exits cleanly.
func TestProxySendErrorDuringBodyChunk(t *testing.T) {
	// Backend returns enough data that it will need to send body chunks.
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("hello"))
	}))
	defer backend.Close()

	p, err := tunnel.NewProxy(backend.URL, "peer-bodyfail")
	if err != nil {
		t.Fatalf("NewProxy: %v", err)
	}

	callCount := 0
	recvCh := make(chan []byte, 64)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		p.Handle(ctx, "peer-bodyfail", func(data []byte) error {
			callCount++
			if callCount == 2 {
				// Second call is the body chunk — fail it.
				return fmt.Errorf("simulated body send error")
			}
			return nil
		}, recvCh)
	}()

	reqRaw, _ := json.Marshal(tunnel.RequestMsg{
		Type: tunnel.MsgRequest, RequestID: "req-bodyfail", Method: "GET", URL: "/", Headers: map[string]string{},
	})
	recvCh <- reqRaw
	endRaw, _ := json.Marshal(tunnel.RequestEndMsg{Type: tunnel.MsgRequestEnd, RequestID: "req-bodyfail"})
	recvCh <- endRaw

	time.Sleep(200 * time.Millisecond)
	cancel()

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Error("Handle did not return after send error during body chunk")
	}
}

// TestProxyRedirectRelativeNotRewritten verifies that relative redirect
// Location values (not starting with /) are left untouched.
func TestProxyRedirectRelativeNotRewritten(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", "https://external.example.com/page")
		w.WriteHeader(http.StatusTemporaryRedirect)
	}))
	defer backend.Close()

	sendCh, recvCh := runProxy(t, backend.URL)

	reqRaw, _ := json.Marshal(tunnel.RequestMsg{
		Type: tunnel.MsgRequest, RequestID: "req-rel-redir", Method: "GET", URL: "/", Headers: map[string]string{},
	})
	recvCh <- reqRaw
	endRaw, _ := json.Marshal(tunnel.RequestEndMsg{Type: tunnel.MsgRequestEnd, RequestID: "req-rel-redir"})
	recvCh <- endRaw

	respRaw := readMsg(t, sendCh, tunnel.MsgResponse)
	var resp tunnel.ResponseMsg
	if err := json.Unmarshal(respRaw, &resp); err != nil {
		t.Fatal(err)
	}
	loc := resp.Headers["Location"]
	// External URL should not be rewritten.
	if loc != "https://external.example.com/page" {
		t.Errorf("Location: got %q, expected unchanged external URL", loc)
	}

	// Drain remaining messages.
	for {
		select {
		case raw := <-sendCh:
			mt, _ := tunnel.DecodeType(raw)
			if mt == tunnel.MsgResponseEnd {
				return
			}
		case <-time.After(3 * time.Second):
			t.Fatal("timeout draining response")
		}
	}
}

// TestProxyQueryStringPreserved verifies that query string params in the
// request URL are forwarded to the backend.
func TestProxyQueryStringPreserved(t *testing.T) {
	var receivedQuery string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer backend.Close()

	sendCh, recvCh := runProxy(t, backend.URL)

	reqRaw, _ := json.Marshal(tunnel.RequestMsg{
		Type: tunnel.MsgRequest, RequestID: "req-qs", Method: "GET", URL: "/search?q=hello&page=2", Headers: map[string]string{},
	})
	recvCh <- reqRaw
	endRaw, _ := json.Marshal(tunnel.RequestEndMsg{Type: tunnel.MsgRequestEnd, RequestID: "req-qs"})
	recvCh <- endRaw

	readMsg(t, sendCh, tunnel.MsgResponse)
	readMsg(t, sendCh, tunnel.MsgResponseBody)
	readMsg(t, sendCh, tunnel.MsgResponseEnd)

	if !strings.Contains(receivedQuery, "q=hello") || !strings.Contains(receivedQuery, "page=2") {
		t.Errorf("query string not preserved: got %q", receivedQuery)
	}
}

// TestProxyHTMLSendErrorDuringBodyChunk verifies that when the send function
// returns an error during an HTML body chunk, the proxy exits cleanly.
func TestProxyHTMLSendErrorDuringBodyChunk(t *testing.T) {
	// Backend returns HTML.
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`<html><head></head><body><p>Hello</p></body></html>`))
	}))
	defer backend.Close()

	p, err := tunnel.NewProxy(backend.URL, "peer-htmlfail")
	if err != nil {
		t.Fatalf("NewProxy: %v", err)
	}

	callCount := 0
	recvCh := make(chan []byte, 64)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		p.Handle(ctx, "peer-htmlfail", func(data []byte) error {
			callCount++
			if callCount == 2 {
				// Second call is the HTML body chunk — fail it.
				return fmt.Errorf("simulated HTML body send error")
			}
			return nil
		}, recvCh)
	}()

	reqRaw, _ := json.Marshal(tunnel.RequestMsg{
		Type: tunnel.MsgRequest, RequestID: "req-htmlfail", Method: "GET", URL: "/", Headers: map[string]string{},
	})
	recvCh <- reqRaw
	endRaw, _ := json.Marshal(tunnel.RequestEndMsg{Type: tunnel.MsgRequestEnd, RequestID: "req-htmlfail"})
	recvCh <- endRaw

	time.Sleep(200 * time.Millisecond)
	cancel()

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Error("Handle did not return after HTML body send error")
	}
}

// TestProxyMalformedRequestBodyJSON verifies that a message with valid type
// tunnel:request-body but invalid JSON body is silently ignored.
func TestProxyMalformedRequestBodyJSON(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer backend.Close()

	p, err := tunnel.NewProxy(backend.URL, "peer-mal-body")
	if err != nil {
		t.Fatalf("NewProxy: %v", err)
	}

	sendCh := make(chan []byte, 64)
	recvCh := make(chan []byte, 64)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	go p.Handle(ctx, "peer-mal-body", func(data []byte) error { sendCh <- data; return nil }, recvCh)

	// Send a valid request first.
	reqRaw, _ := json.Marshal(tunnel.RequestMsg{
		Type: tunnel.MsgRequest, RequestID: "req-x", Method: "GET", URL: "/", Headers: map[string]string{},
	})
	recvCh <- reqRaw

	// Send a tunnel:request-body with valid type but garbled requestId field.
	// The JSON is valid enough to decode the type but not the full struct.
	recvCh <- []byte(`{"type":"tunnel:request-body","requestId":123,"data":"aGVsbG8="}`)

	// Send a tunnel:request-end with invalid JSON structure.
	recvCh <- []byte(`{"type":"tunnel:request-end","requestId":456}`)

	// Send the real request-end to complete the pending request.
	endRaw, _ := json.Marshal(tunnel.RequestEndMsg{Type: tunnel.MsgRequestEnd, RequestID: "req-x"})
	recvCh <- endRaw

	readMsg(t, sendCh, tunnel.MsgResponse)
	readMsg(t, sendCh, tunnel.MsgResponseBody)
	readMsg(t, sendCh, tunnel.MsgResponseEnd)
}

// TestProxyMalformedRequestJSON verifies that a message with type tunnel:request
// but invalid JSON for the full struct is silently ignored.
func TestProxyMalformedRequestJSON(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer backend.Close()

	p, err := tunnel.NewProxy(backend.URL, "peer-mal-req")
	if err != nil {
		t.Fatalf("NewProxy: %v", err)
	}

	sendCh := make(chan []byte, 64)
	recvCh := make(chan []byte, 64)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	go p.Handle(ctx, "peer-mal-req", func(data []byte) error { sendCh <- data; return nil }, recvCh)

	// Send a tunnel:request with invalid fields — should be silently ignored.
	recvCh <- []byte(`{"type":"tunnel:request","requestId":999}`)

	// Send a valid request afterward to prove loop survives.
	reqRaw, _ := json.Marshal(tunnel.RequestMsg{
		Type: tunnel.MsgRequest, RequestID: "req-ok", Method: "GET", URL: "/", Headers: map[string]string{},
	})
	recvCh <- reqRaw
	endRaw, _ := json.Marshal(tunnel.RequestEndMsg{Type: tunnel.MsgRequestEnd, RequestID: "req-ok"})
	recvCh <- endRaw

	readMsg(t, sendCh, tunnel.MsgResponse)
	readMsg(t, sendCh, tunnel.MsgResponseBody)
	readMsg(t, sendCh, tunnel.MsgResponseEnd)
}

// TestProxyInvalidHTTPMethod verifies that an invalid HTTP method in the
// tunnel:request returns an error response. This exercises the
// http.NewRequestWithContext error path in proxyRequest.
func TestProxyInvalidHTTPMethod(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	defer srv.Close()

	sendCh, recvCh := runProxy(t, srv.URL)

	// Send a request with an invalid HTTP method containing a space (rejected by net/http).
	reqMsg, _ := tunnel.Encode(tunnel.RequestMsg{
		Type:      tunnel.MsgRequest,
		RequestID: "invalid-method-test",
		Method:    "INVALID METHOD",
		URL:       "/test",
	})
	recvCh <- reqMsg

	endMsg, _ := tunnel.Encode(tunnel.RequestEndMsg{
		Type:      tunnel.MsgRequestEnd,
		RequestID: "invalid-method-test",
	})
	recvCh <- endMsg

	// Should get a tunnel:error response.
	raw := readMsg(t, sendCh, tunnel.MsgError)
	var errMsg tunnel.ErrorMsg
	if err := json.Unmarshal(raw, &errMsg); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}
	if !strings.Contains(errMsg.Message, "build request") {
		t.Errorf("error message = %q, expected to contain 'build request'", errMsg.Message)
	}
}

// TestProxyHTMLWithHeadTag verifies injection after <head>.
func TestProxyHTMLWithUppercaseHead(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusOK)
		// Use uppercase HEAD to test case-insensitive matching.
		_, _ = w.Write([]byte(`<html><HEAD><title>Test</title></HEAD><body></body></html>`))
	}))
	defer backend.Close()

	sendCh, recvCh := runProxy(t, backend.URL)

	reqRaw, _ := json.Marshal(tunnel.RequestMsg{
		Type: tunnel.MsgRequest, RequestID: "req-uchead", Method: "GET", URL: "/", Headers: map[string]string{},
	})
	recvCh <- reqRaw
	endRaw, _ := json.Marshal(tunnel.RequestEndMsg{Type: tunnel.MsgRequestEnd, RequestID: "req-uchead"})
	recvCh <- endRaw

	readMsg(t, sendCh, tunnel.MsgResponse)
	bodyRaw := readMsg(t, sendCh, tunnel.MsgResponseBody)
	var body tunnel.ResponseBodyMsg
	if err := json.Unmarshal(bodyRaw, &body); err != nil {
		t.Fatal(err)
	}
	decoded, _ := base64.StdEncoding.DecodeString(body.Data)
	html := string(decoded)

	if !strings.Contains(html, `<base href="/tunnel/peer-test/">`) {
		t.Errorf("missing base tag in HTML with uppercase HEAD:\n%s", html)
	}
	readMsg(t, sendCh, tunnel.MsgResponseEnd)
}
