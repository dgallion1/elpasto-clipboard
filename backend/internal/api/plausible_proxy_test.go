package api

import (
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
