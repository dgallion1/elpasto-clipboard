package api

import (
	"crypto/tls"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPlausibleScriptHandler_Disabled(t *testing.T) {
	h := newPlausibleScriptHandler(plausibleConfig{scriptURL: ""}, http.DefaultClient)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/pl/script.js", nil)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 when disabled, got %d", rec.Code)
	}
}

func TestPlausibleScriptHandler_ProxiesUpstream(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Fatalf("upstream got %s, want GET", r.Method)
		}
		if cookie := r.Header.Get("Cookie"); cookie != "" {
			t.Fatalf("upstream got cookie header %q; should be stripped", cookie)
		}
		w.Header().Set("Content-Type", "application/javascript")
		io.WriteString(w, "/* fake plausible script */")
	}))
	defer upstream.Close()

	h := newPlausibleScriptHandler(plausibleConfig{scriptURL: upstream.URL}, &http.Client{Timeout: 5 * time.Second})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/pl/script.js", nil)
	req.Header.Set("Cookie", "session=secret")
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "fake plausible script") {
		t.Fatalf("body = %q", rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "application/javascript" {
		t.Fatalf("content-type = %q", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=21600" {
		t.Fatalf("cache-control = %q", got)
	}
}

func TestPlausibleScriptHandler_RejectsNonGet(t *testing.T) {
	h := newPlausibleScriptHandler(plausibleConfig{scriptURL: "http://example.invalid"}, http.DefaultClient)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/pl/script.js", nil)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}

func TestPlausibleScriptHandler_UpstreamFailureReturns502(t *testing.T) {
	h := newPlausibleScriptHandler(plausibleConfig{scriptURL: "http://127.0.0.1:1"}, &http.Client{Timeout: 200 * time.Millisecond})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/pl/script.js", nil)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d", rec.Code)
	}
}

func TestPlausibleEventHandler_Disabled(t *testing.T) {
	h := newPlausibleEventHandler(plausibleConfig{eventURL: ""}, http.DefaultClient)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/pl/event", strings.NewReader(`{}`))
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 when disabled, got %d", rec.Code)
	}
}

func TestPlausibleEventHandler_ForwardsCFConnectingIP(t *testing.T) {
	var gotXFF string
	var gotUA string
	var gotBody string
	var gotCookie string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotXFF = r.Header.Get("X-Forwarded-For")
		gotUA = r.Header.Get("User-Agent")
		gotCookie = r.Header.Get("Cookie")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(http.StatusAccepted)
	}))
	defer upstream.Close()

	h := newPlausibleEventHandler(plausibleConfig{eventURL: upstream.URL}, &http.Client{Timeout: 5 * time.Second})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/pl/event", strings.NewReader(`{"name":"pageview"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Mozilla/5.0 test")
	req.Header.Set("CF-Connecting-IP", "203.0.113.7")
	req.Header.Set("X-Forwarded-For", "10.0.0.1")
	req.Header.Set("Cookie", "session=secret")
	req.RemoteAddr = "127.0.0.1:1234"
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202", rec.Code)
	}
	if gotXFF != "203.0.113.7" {
		t.Fatalf("X-Forwarded-For = %q, want \"203.0.113.7\"", gotXFF)
	}
	if gotUA != "Mozilla/5.0 test" {
		t.Fatalf("User-Agent = %q", gotUA)
	}
	if gotBody != `{"name":"pageview"}` {
		t.Fatalf("body = %q", gotBody)
	}
	if gotCookie != "" {
		t.Fatalf("cookie should be stripped, got %q", gotCookie)
	}
}

func TestPlausibleEventHandler_FallsBackToXFF(t *testing.T) {
	var gotXFF string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotXFF = r.Header.Get("X-Forwarded-For")
		w.WriteHeader(http.StatusAccepted)
	}))
	defer upstream.Close()

	h := newPlausibleEventHandler(plausibleConfig{eventURL: upstream.URL}, &http.Client{Timeout: 5 * time.Second})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/pl/event", strings.NewReader(`{}`))
	req.Header.Set("X-Forwarded-For", "198.51.100.5, 10.0.0.1")
	req.RemoteAddr = "10.0.0.99:5555"
	h.ServeHTTP(rec, req)

	if gotXFF != "198.51.100.5" {
		t.Fatalf("X-Forwarded-For = %q, want \"198.51.100.5\"", gotXFF)
	}
}

func TestPlausibleEventHandler_FallsBackToRemoteAddr(t *testing.T) {
	var gotXFF string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotXFF = r.Header.Get("X-Forwarded-For")
		w.WriteHeader(http.StatusAccepted)
	}))
	defer upstream.Close()

	h := newPlausibleEventHandler(plausibleConfig{eventURL: upstream.URL}, &http.Client{Timeout: 5 * time.Second})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/pl/event", strings.NewReader(`{}`))
	req.RemoteAddr = "198.51.100.42:5555"
	h.ServeHTTP(rec, req)

	if gotXFF != "198.51.100.42" {
		t.Fatalf("X-Forwarded-For = %q, want \"198.51.100.42\"", gotXFF)
	}
}

func TestPlausibleEventHandler_RejectsNonPost(t *testing.T) {
	h := newPlausibleEventHandler(plausibleConfig{eventURL: "http://example.invalid"}, http.DefaultClient)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/pl/event", nil)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}

func TestPlausibleEventHandler_UpstreamFailureReturns502(t *testing.T) {
	h := newPlausibleEventHandler(plausibleConfig{eventURL: "http://127.0.0.1:1"}, &http.Client{Timeout: 200 * time.Millisecond})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/pl/event", strings.NewReader(`{}`))
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d", rec.Code)
	}
}

func TestPlausibleEventHandler_MissingContentTypeAndUserAgent(t *testing.T) {
	// When the incoming request has no Content-Type and no User-Agent, the
	// handler skips the conditional header-set lines for both. The upstream
	// request will NOT have Content-Type explicitly set by the proxy; Go's
	// HTTP transport may still add a default User-Agent, but the handler's
	// conditional branch (ua != "") is false, which is what we cover.
	var gotContentType string
	var gotUserAgentFromProxy bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotContentType = r.Header.Get("Content-Type")
		// If the proxy set the User-Agent, it would match the original request's
		// UA. Since we cleared it, the proxy does not set it explicitly.
		// Go's transport adds "Go-http-client/1.1" as default.
		gotUserAgentFromProxy = r.Header.Get("User-Agent") != "Go-http-client/1.1" && r.Header.Get("User-Agent") != ""
		w.WriteHeader(http.StatusAccepted)
	}))
	defer upstream.Close()

	h := newPlausibleEventHandler(plausibleConfig{eventURL: upstream.URL}, &http.Client{Timeout: 5 * time.Second})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/pl/event", strings.NewReader(`{}`))
	// Explicitly remove Content-Type and User-Agent headers.
	req.Header.Del("Content-Type")
	req.Header.Del("User-Agent")
	req.RemoteAddr = "198.51.100.1:1234"
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202", rec.Code)
	}
	if gotContentType != "" {
		t.Fatalf("expected no Content-Type upstream, got %q", gotContentType)
	}
	if gotUserAgentFromProxy {
		t.Fatal("proxy should not have explicitly set User-Agent from empty request header")
	}
}

func TestPlausibleEventHandler_ForwardsUpstreamContentType(t *testing.T) {
	// When the upstream response includes Content-Type, the proxy should
	// forward it to the client response.
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, `{"ok":true}`)
	}))
	defer upstream.Close()

	h := newPlausibleEventHandler(plausibleConfig{eventURL: upstream.URL}, &http.Client{Timeout: 5 * time.Second})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/pl/event", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q, want \"application/json; charset=utf-8\"", ct)
	}
}

func TestPlausibleClientIP_XFFWithoutComma(t *testing.T) {
	// X-Forwarded-For with a single IP (no comma).
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("X-Forwarded-For", "203.0.113.50")
	req.RemoteAddr = "10.0.0.1:1234"

	got := plausibleClientIP(req)
	if got != "203.0.113.50" {
		t.Fatalf("plausibleClientIP = %q, want \"203.0.113.50\"", got)
	}
}

func TestPlausibleClientIP_CFConnectingIP(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("CF-Connecting-IP", "198.51.100.99")
	req.Header.Set("X-Forwarded-For", "10.0.0.1")
	req.RemoteAddr = "172.16.0.1:5555"

	got := plausibleClientIP(req)
	if got != "198.51.100.99" {
		t.Fatalf("plausibleClientIP = %q, want \"198.51.100.99\"", got)
	}
}

func TestPlausibleClientIP_BareRemoteAddr(t *testing.T) {
	// RemoteAddr without a port (SplitHostPort fails) — fallback to raw RemoteAddr.
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "bare-address"

	got := plausibleClientIP(req)
	if got != "bare-address" {
		t.Fatalf("plausibleClientIP = %q, want \"bare-address\"", got)
	}
}

func TestPlausibleClientProto_XForwardedProto(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("X-Forwarded-Proto", "https")

	got := plausibleClientProto(req)
	if got != "https" {
		t.Fatalf("plausibleClientProto = %q, want \"https\"", got)
	}
}

func TestPlausibleClientProto_TLSSet(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	req.TLS = &tls.ConnectionState{}

	got := plausibleClientProto(req)
	if got != "https" {
		t.Fatalf("plausibleClientProto = %q, want \"https\"", got)
	}
}

func TestPlausibleClientProto_DefaultHTTP(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)

	got := plausibleClientProto(req)
	if got != "http" {
		t.Fatalf("plausibleClientProto = %q, want \"http\"", got)
	}
}

func TestPlausibleScriptHandler_HeadMethod(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript")
		io.WriteString(w, "/* script body */")
	}))
	defer upstream.Close()

	h := newPlausibleScriptHandler(plausibleConfig{scriptURL: upstream.URL}, &http.Client{Timeout: 5 * time.Second})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("HEAD", "/pl/script.js", nil)
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	// HEAD should not include a body.
	if rec.Body.Len() != 0 {
		t.Fatalf("expected empty body for HEAD, got %d bytes", rec.Body.Len())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/javascript" {
		t.Fatalf("Content-Type = %q, want \"application/javascript\"", ct)
	}
}

func TestPlausibleScriptHandler_UpstreamMissingContentType(t *testing.T) {
	// When upstream omits Content-Type, the handler should default to application/javascript.
	// Go's net/http server auto-detects Content-Type on Write, so we must
	// avoid writing a body to keep the response Content-Type header empty.
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header()["Content-Type"] = nil // remove the default
		w.WriteHeader(http.StatusOK)
		// No body — avoids Go's auto content-type detection.
	}))
	defer upstream.Close()

	h := newPlausibleScriptHandler(plausibleConfig{scriptURL: upstream.URL}, &http.Client{Timeout: 5 * time.Second})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/pl/script.js", nil)
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/javascript" {
		t.Fatalf("Content-Type = %q, want \"application/javascript\"", ct)
	}
}

func TestPlausibleScriptHandler_PostMethodNotAllowed(t *testing.T) {
	// POST to the script handler should return 405.
	h := newPlausibleScriptHandler(plausibleConfig{scriptURL: "http://example.invalid"}, http.DefaultClient)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/pl/script.js", nil)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
	if allow := rec.Header().Get("Allow"); allow != "GET, HEAD" {
		t.Fatalf("Allow = %q, want \"GET, HEAD\"", allow)
	}
}

func TestPlausibleScriptHandler_UpstreamError(t *testing.T) {
	h := newPlausibleScriptHandler(plausibleConfig{scriptURL: "http://127.0.0.1:1"}, &http.Client{Timeout: 200 * time.Millisecond})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/pl/script.js", nil)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d", rec.Code)
	}
}

func TestPlausibleEventHandler_BadUpstreamURL(t *testing.T) {
	// A URL with a control character causes http.NewRequestWithContext to fail,
	// exercising the "bad upstream url" error path.
	h := newPlausibleEventHandler(plausibleConfig{eventURL: "http://bad\x00url"}, http.DefaultClient)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/pl/event", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 for bad upstream URL, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "bad upstream url") {
		t.Fatalf("expected 'bad upstream url' in body, got %q", rec.Body.String())
	}
}

func TestPlausibleScriptHandler_BadUpstreamURL(t *testing.T) {
	// Same as above for the script handler.
	h := newPlausibleScriptHandler(plausibleConfig{scriptURL: "http://bad\x00url"}, http.DefaultClient)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/pl/script.js", nil)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 for bad upstream URL, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "bad upstream url") {
		t.Fatalf("expected 'bad upstream url' in body, got %q", rec.Body.String())
	}
}

func TestPlausibleEventHandler_NilClient(t *testing.T) {
	// Pass nil as the HTTP client to exercise the default client creation path.
	var gotXFF string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotXFF = r.Header.Get("X-Forwarded-For")
		w.WriteHeader(http.StatusAccepted)
	}))
	defer upstream.Close()

	h := newPlausibleEventHandler(plausibleConfig{eventURL: upstream.URL}, nil)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/pl/event", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "198.51.100.1:5555"
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202", rec.Code)
	}
	if gotXFF != "198.51.100.1" {
		t.Fatalf("X-Forwarded-For = %q, want \"198.51.100.1\"", gotXFF)
	}
}

func TestPlausibleScriptHandler_NilClient(t *testing.T) {
	// Pass nil as the HTTP client to exercise the default client creation path.
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript")
		io.WriteString(w, "/* script */")
	}))
	defer upstream.Close()

	h := newPlausibleScriptHandler(plausibleConfig{scriptURL: upstream.URL}, nil)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/pl/script.js", nil)
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "/* script */") {
		t.Fatalf("body = %q", rec.Body.String())
	}
}

func TestPlausibleScriptHandler_ForwardsUserAgent(t *testing.T) {
	// When the incoming request has a User-Agent, it should be forwarded upstream.
	var gotUA string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUA = r.Header.Get("User-Agent")
		w.Header().Set("Content-Type", "application/javascript")
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	h := newPlausibleScriptHandler(plausibleConfig{scriptURL: upstream.URL}, &http.Client{Timeout: 5 * time.Second})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/pl/script.js", nil)
	req.Header.Set("User-Agent", "TestBrowser/1.0")
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if gotUA != "TestBrowser/1.0" {
		t.Fatalf("User-Agent = %q, want \"TestBrowser/1.0\"", gotUA)
	}
}

func TestPlausibleScriptHandler_MissingUserAgent(t *testing.T) {
	// When the incoming request has no User-Agent, the proxy skips the
	// conditional header-set. Go's HTTP transport adds a default
	// "Go-http-client/1.1", but the proxy's branch (ua != "") is false.
	var gotUserAgentFromProxy bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The proxy should NOT set a custom User-Agent. Go's transport sets
		// "Go-http-client/1.1" as default if no UA is set on the request.
		ua := r.Header.Get("User-Agent")
		gotUserAgentFromProxy = ua != "" && ua != "Go-http-client/1.1"
		w.Header().Set("Content-Type", "application/javascript")
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	h := newPlausibleScriptHandler(plausibleConfig{scriptURL: upstream.URL}, &http.Client{Timeout: 5 * time.Second})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/pl/script.js", nil)
	req.Header.Del("User-Agent")
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if gotUserAgentFromProxy {
		t.Fatal("proxy should not have explicitly set User-Agent from empty request header")
	}
}
