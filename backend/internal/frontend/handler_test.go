package frontend

import (
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"testing/fstest"
)

func testHandler(t *testing.T, files fstest.MapFS) http.Handler {
	t.Helper()
	return newHandler(fs.FS(files))
}

func TestHandlerServesRootHTML(t *testing.T) {
	handler := testHandler(t, fstest.MapFS{
		"index.html": {Data: []byte("<html><body>home</body></html>")},
		"token.html": {Data: []byte("<html><body>token=" + tokenPlaceholder + "</body></html>")},
	})

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); !strings.Contains(got, "text/html") {
		t.Fatalf("expected html content type, got %q", got)
	}
	if !strings.Contains(rec.Body.String(), "home") {
		t.Fatalf("unexpected body: %q", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "window.__ELPASTO_BUILD_ID__=") {
		t.Fatalf("expected build id script in body: %q", rec.Body.String())
	}
}

func TestHandlerServesStatsHTML(t *testing.T) {
	handler := testHandler(t, fstest.MapFS{
		"index.html": {Data: []byte("<html><body>home</body></html>")},
		"token.html": {Data: []byte("<html><body>token=" + tokenPlaceholder + "</body></html>")},
		"stats.html": {Data: []byte("<html><body>stats-page</body></html>")},
	})

	for _, path := range []string{"/stats", "/stats/"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("%s: expected 200, got %d", path, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "stats-page") {
			t.Fatalf("%s: expected stats-page body, got %q", path, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "window.__ELPASTO_BUILD_ID__=") {
			t.Fatalf("%s: expected build id injection, got %q", path, rec.Body.String())
		}
	}
}

func TestHandlerServesTokenTemplateWithReplacement(t *testing.T) {
	handler := testHandler(t, fstest.MapFS{
		"index.html": {Data: []byte("<html><body>home</body></html>")},
		"token.html": {Data: []byte("<html><body>token=" + tokenPlaceholder + "</body></html>")},
	})

	req := httptest.NewRequest(http.MethodGet, "/amber-anchor-apple-arch-arrow", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "token=amber-anchor-apple-arch-arrow") {
		t.Fatalf("unexpected token html: %q", rec.Body.String())
	}
}

func TestHandlerServesBuildVersion(t *testing.T) {
	handler := testHandler(t, fstest.MapFS{
		"index.html": {Data: []byte("<html><body>home</body></html>")},
		"token.html": {Data: []byte("<html><body>token=" + tokenPlaceholder + "</body></html>")},
	})

	getReq := httptest.NewRequest(http.MethodGet, buildVersionPath, nil)
	getRec := httptest.NewRecorder()
	handler.ServeHTTP(getRec, getReq)

	if getRec.Code != http.StatusOK {
		t.Fatalf("expected GET 200, got %d", getRec.Code)
	}
	if got := getRec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("expected no-store cache control, got %q", got)
	}
	if got := getRec.Header().Get("Content-Type"); !strings.Contains(got, "text/plain") {
		t.Fatalf("expected text/plain content type, got %q", got)
	}
	if body := strings.TrimSpace(getRec.Body.String()); body == "" {
		t.Fatal("expected build version response body")
	}

	headReq := httptest.NewRequest(http.MethodHead, buildVersionPath, nil)
	headRec := httptest.NewRecorder()
	handler.ServeHTTP(headRec, headReq)

	if headRec.Code != http.StatusOK {
		t.Fatalf("expected HEAD 200, got %d", headRec.Code)
	}
	if headRec.Body.Len() != 0 {
		t.Fatalf("expected empty HEAD body, got %q", headRec.Body.String())
	}
}

func TestHandlerServesEmbeddedStaticAssets(t *testing.T) {
	handler := testHandler(t, fstest.MapFS{
		"_next/static/chunks/app.js": {Data: []byte("console.log('ok')")},
		"index.html":                 {Data: []byte("<html><body>home</body></html>")},
		"token.html":                 {Data: []byte("<html><body>token=" + tokenPlaceholder + "</body></html>")},
	})

	req := httptest.NewRequest(http.MethodGet, "/_next/static/chunks/app.js", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Fatalf("unexpected cache control header: %q", got)
	}
	if rec.Body.String() != "console.log('ok')" {
		t.Fatalf("unexpected asset body: %q", rec.Body.String())
	}
}

func TestHandlerSWFilesGetNoCacheHeaders(t *testing.T) {
	handler := testHandler(t, fstest.MapFS{
		"tunnel-sw2.js": {Data: []byte("// service worker")},
		"index.html":    {Data: []byte("<html><body>home</body></html>")},
		"token.html":    {Data: []byte("<html><body>token=" + tokenPlaceholder + "</body></html>")},
	})

	req := httptest.NewRequest(http.MethodGet, "/tunnel-sw2.js", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-cache, no-store, must-revalidate" {
		t.Fatalf("expected no-cache for SW file, got %q", got)
	}
}

func TestHandlerMissingStaticAssetReturnsNotFound(t *testing.T) {
	handler := testHandler(t, fstest.MapFS{
		"index.html": {Data: []byte("<html><body>home</body></html>")},
		"token.html": {Data: []byte("<html><body>token=" + tokenPlaceholder + "</body></html>")},
	})

	req := httptest.NewRequest(http.MethodGet, "/_next/static/chunks/missing.js", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
}

func TestHandlerAppliesSecurityHeaders(t *testing.T) {
	t.Setenv("NODE_ENV", "production")

	handler := testHandler(t, fstest.MapFS{
		"index.html": {Data: []byte("<html><body>home</body></html>")},
	})

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	checks := map[string]string{
		"Content-Security-Policy":   "default-src 'self'",
		"X-Content-Type-Options":    "nosniff",
		"X-Frame-Options":           "DENY",
		"Referrer-Policy":           "same-origin",
		"Permissions-Policy":        "camera=()",
		"Strict-Transport-Security": "max-age=31536000; includeSubDomains",
	}
	for header, want := range checks {
		if got := rec.Header().Get(header); !strings.Contains(got, want) {
			t.Fatalf("%s = %q, want substring %q", header, got, want)
		}
	}
}

func TestHandlerHeadFaviconAndAPINotFound(t *testing.T) {
	handler := testHandler(t, fstest.MapFS{
		"icon.svg":   {Data: []byte("<svg />")},
		"index.html": {Data: []byte("<html><body>home</body></html>")},
	})

	headReq := httptest.NewRequest(http.MethodHead, "/", nil)
	headRec := httptest.NewRecorder()
	handler.ServeHTTP(headRec, headReq)
	if headRec.Code != http.StatusOK || headRec.Body.Len() != 0 {
		t.Fatalf("unexpected HEAD response: code=%d body=%q", headRec.Code, headRec.Body.String())
	}

	faviconReq := httptest.NewRequest(http.MethodGet, "/favicon.ico", nil)
	faviconRec := httptest.NewRecorder()
	handler.ServeHTTP(faviconRec, faviconReq)
	if faviconRec.Code != http.StatusOK || faviconRec.Body.String() != "<svg />" {
		t.Fatalf("unexpected favicon response: code=%d body=%q", faviconRec.Code, faviconRec.Body.String())
	}

	apiReq := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	apiRec := httptest.NewRecorder()
	handler.ServeHTTP(apiRec, apiReq)
	if apiRec.Code != http.StatusNotFound {
		t.Fatalf("expected api path 404, got %d", apiRec.Code)
	}
}

func TestHandlerRejectsUnsupportedMethodsAndDirectories(t *testing.T) {
	fsMap := fstest.MapFS{
		"dir/file.txt": {Data: []byte("x")},
		"index.html":   {Data: []byte("<html><body>home</body></html>")},
	}
	app := testHandler(t, fsMap)

	postReq := httptest.NewRequest(http.MethodPost, "/", nil)
	postRec := httptest.NewRecorder()
	app.ServeHTTP(postRec, postReq)
	if postRec.Code != http.StatusNotFound {
		t.Fatalf("expected POST 404, got %d", postRec.Code)
	}

	embedded := newHandler(fs.FS(fsMap)).(*handler)
	if embedded.serveEmbeddedFile(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/dir", nil), "dir") {
		t.Fatal("expected directory asset not to be served")
	}
}

func TestFallbackHelpersAndTokenParsing(t *testing.T) {
	fallback := []byte("fallback")
	if got := string(mustReadHTML(fstest.MapFS{}, "missing.html", fallback)); got != "fallback" {
		t.Fatalf("mustReadHTML fallback = %q", got)
	}

	if got := cleanAssetPath("/../foo.js"); got != "foo.js" {
		t.Fatalf("cleanAssetPath = %q", got)
	}
	if got := cleanAssetPath("/"); got != "" {
		t.Fatalf("cleanAssetPath root = %q", got)
	}

	if token, ok := tokenFromPath("/amber-anchor-apple-arch-arrow"); !ok || token != "amber-anchor-apple-arch-arrow" {
		t.Fatalf("tokenFromPath valid = %q ok=%v", token, ok)
	}
	for _, path := range []string{"/", "/nested/token", "/file.txt", "/token-value"} {
		if _, ok := tokenFromPath(path); ok {
			t.Fatalf("expected tokenFromPath(%q) to fail", path)
		}
	}
}

func TestBuildIDHelpers(t *testing.T) {
	first := computeBuildID([]byte("index"), []byte("token"))
	second := computeBuildID([]byte("index"), []byte("token"))
	third := computeBuildID([]byte("index-changed"), []byte("token"))

	if first != second {
		t.Fatalf("expected stable build id, got %q and %q", first, second)
	}
	if first == third {
		t.Fatalf("expected build id to change when content changes")
	}

	headHTML := string(injectBuildID([]byte("<html><head></head><body>ok</body></html>"), "abc123"))
	if !strings.Contains(headHTML, `window.__ELPASTO_BUILD_ID__="abc123"`) {
		t.Fatalf("expected build id script, got %q", headHTML)
	}
}

func TestEscapedTokenValueEscapesScriptTerminators(t *testing.T) {
	if got := string(escapedTokenValue(`</script>"token"`)); got != `\u003c/script\u003e\"token\"` {
		t.Fatalf("escapedTokenValue = %q", got)
	}
}

func TestExtractPeerFromPrefix(t *testing.T) {
	tests := []struct {
		name   string
		path   string
		prefix string
		wantID string
		wantOK bool
	}{
		{"valid uuid", "/tunnel/550e8400-e29b-41d4/rest", "/tunnel/", "550e8400-e29b-41d4", true},
		{"valid simple", "/tunnel/abc123/", "/tunnel/", "abc123", true},
		{"no trailing path", "/tunnel/abc123", "/tunnel/", "abc123", true},
		{"wrong prefix", "/other/abc123", "/tunnel/", "", false},
		{"empty peer", "/tunnel/", "/tunnel/", "", false},
		{"invalid chars", "/tunnel/abc!@#/rest", "/tunnel/", "", false},
		{"spaces", "/tunnel/abc 123/rest", "/tunnel/", "", false},
		{"dots", "/tunnel/abc.123/rest", "/tunnel/", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			id, ok := extractPeerFromPrefix(tt.path, tt.prefix)
			if ok != tt.wantOK || id != tt.wantID {
				t.Fatalf("extractPeerFromPrefix(%q, %q) = (%q, %v), want (%q, %v)",
					tt.path, tt.prefix, id, ok, tt.wantID, tt.wantOK)
			}
		})
	}
}

func TestTunnelPeerFromPath(t *testing.T) {
	if id, ok := tunnelPeerFromPath("/tunnel/abc-123/index.html"); !ok || id != "abc-123" {
		t.Fatalf("tunnelPeerFromPath valid = (%q, %v)", id, ok)
	}
	if _, ok := tunnelPeerFromPath("/other/abc-123"); ok {
		t.Fatal("expected tunnelPeerFromPath to reject non-tunnel path")
	}
}

func TestHandlerServesTokenWithSpecialChars(t *testing.T) {
	// Test escapedTokenValue with a normal token — should pass through unchanged.
	normal := escapedTokenValue("amber-anchor-apple-arch-arrow")
	if string(normal) != "amber-anchor-apple-arch-arrow" {
		t.Fatalf("escapedTokenValue normal = %q", normal)
	}
}

func TestEscapedTokenValueEmptyString(t *testing.T) {
	// Empty string produces `""` from json.Marshal — len=2, returns empty slice.
	got := escapedTokenValue("")
	if len(got) != 0 {
		t.Fatalf("escapedTokenValue(\"\") = %q, want empty", got)
	}
}

func TestHandlerServesHTMLHead(t *testing.T) {
	handler := testHandler(t, fstest.MapFS{
		"index.html": {Data: []byte("<html><body>home</body></html>")},
		"token.html": {Data: []byte("<html><body>token=" + tokenPlaceholder + "</body></html>")},
	})

	// HEAD request for a token page should return 200 with empty body.
	req := httptest.NewRequest(http.MethodHead, "/amber-anchor-apple-arch-arrow", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("expected empty body for HEAD, got %q", rec.Body.String())
	}
}

func TestHandlerTunnelViewPath(t *testing.T) {
	handler := testHandler(t, fstest.MapFS{
		"index.html":       {Data: []byte("<html><body>home</body></html>")},
		"tunnel.html":      {Data: []byte("<html><body>tunnel=" + tunnelPeerPlaceholder + "</body></html>")},
		"tunnel-view.html": {Data: []byte("<html><body>view=" + tunnelPeerPlaceholder + "</body></html>")},
	})

	// tunnel-view path
	req := httptest.NewRequest(http.MethodGet, "/tunnel-view/abc-123", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "view=abc-123") {
		t.Fatalf("unexpected body: %q", rec.Body.String())
	}
}

func TestHandlerTunnelPath(t *testing.T) {
	handler := testHandler(t, fstest.MapFS{
		"index.html":  {Data: []byte("<html><body>home</body></html>")},
		"tunnel.html": {Data: []byte("<html><body>tunnel=" + tunnelPeerPlaceholder + "</body></html>")},
	})

	req := httptest.NewRequest(http.MethodGet, "/tunnel/peer-456/somepath", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "tunnel=peer-456") {
		t.Fatalf("unexpected body: %q", rec.Body.String())
	}
}

func TestHandlerUnknownPathReturns404(t *testing.T) {
	handler := testHandler(t, fstest.MapFS{
		"index.html": {Data: []byte("<html><body>home</body></html>")},
	})

	req := httptest.NewRequest(http.MethodGet, "/not-a-valid-token", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
}

func TestInjectBuildIDBodyFallback(t *testing.T) {
	// No </head> or </body> — should append to end.
	body := []byte("<html>hello</html>")
	result := string(injectBuildID(body, "test123"))
	if !strings.Contains(result, `window.__ELPASTO_BUILD_ID__="test123"`) {
		t.Fatalf("expected build id appended, got %q", result)
	}
}

func TestInjectBuildIDBodyTag(t *testing.T) {
	// Has </body> but no </head> — should inject before </body>.
	body := []byte("<html><body>ok</body></html>")
	result := string(injectBuildID(body, "abc"))
	if !strings.Contains(result, `window.__ELPASTO_BUILD_ID__="abc"`) {
		t.Fatalf("expected build id before body, got %q", result)
	}
	if idx := strings.Index(result, `__ELPASTO_BUILD_ID__`); idx > strings.Index(result, "</body>") {
		t.Fatal("build id should be before </body>")
	}
}

func TestTunnelViewPeerFromPath(t *testing.T) {
	if id, ok := tunnelViewPeerFromPath("/tunnel-view/abc-123"); !ok || id != "abc-123" {
		t.Fatalf("tunnelViewPeerFromPath valid = (%q, %v)", id, ok)
	}
	if _, ok := tunnelViewPeerFromPath("/other/abc-123"); ok {
		t.Fatal("expected tunnelViewPeerFromPath to reject non-tunnel-view path")
	}
}

func TestHandlerUsesEmbeddedDist(t *testing.T) {
	handler := Handler()

	req := httptest.NewRequest(http.MethodGet, buildVersionPath, nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if strings.TrimSpace(rec.Body.String()) == "" {
		t.Fatal("expected embedded handler build version response body")
	}
}

func TestHandlerPanicsOnFsSubError(t *testing.T) {
	original := fsSubFunc
	t.Cleanup(func() { fsSubFunc = original })

	fsSubFunc = func(fsys fs.FS, dir string) (fs.FS, error) {
		return nil, errors.New("forced sub error")
	}

	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("expected panic for broken fs.Sub")
		}
		msg, ok := r.(string)
		if !ok || !strings.Contains(msg, "embedded dist directory missing") {
			t.Fatalf("unexpected panic value: %v", r)
		}
	}()

	Handler()
}

func TestEscapedTokenValueMarshalError(t *testing.T) {
	original := jsonMarshalString
	t.Cleanup(func() { jsonMarshalString = original })

	// Simulate json.Marshal returning an error.
	jsonMarshalString = func(s string) ([]byte, error) {
		return nil, errors.New("forced error")
	}

	got := escapedTokenValue("hello")
	if string(got) != "hello" {
		t.Fatalf("expected fallback to raw token, got %q", got)
	}
}

func TestEscapedTokenValueShortMarshal(t *testing.T) {
	original := jsonMarshalString
	t.Cleanup(func() { jsonMarshalString = original })

	// Simulate json.Marshal returning a single-byte result (len < 2).
	jsonMarshalString = func(s string) ([]byte, error) {
		return []byte("x"), nil
	}

	got := escapedTokenValue("hello")
	if string(got) != "hello" {
		t.Fatalf("expected fallback to raw token, got %q", got)
	}
}

func TestNonceCSPNoncesInlineScripts(t *testing.T) {
	handler := testHandler(t, fstest.MapFS{
		"index.html": {Data: []byte(`<html><head></head><body><script>doThing()</script><script src="/a.js"></script>home</body></html>`)},
	})

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	csp := rec.Header().Get("Content-Security-Policy")
	// Pull the script-src directive out and assert it's nonce-based, not unsafe-inline.
	var scriptSrc string
	for _, d := range strings.Split(csp, ";") {
		if strings.Contains(d, "script-src") {
			scriptSrc = strings.TrimSpace(d)
		}
	}
	if scriptSrc == "" {
		t.Fatalf("no script-src directive in CSP: %q", csp)
	}
	if strings.Contains(scriptSrc, "'unsafe-inline'") {
		t.Fatalf("script-src must not contain 'unsafe-inline': %q", scriptSrc)
	}
	m := regexp.MustCompile(`'nonce-([A-Za-z0-9+/_-]+)'`).FindStringSubmatch(scriptSrc)
	if m == nil {
		t.Fatalf("script-src must contain a nonce: %q", scriptSrc)
	}
	nonce := m[1]

	body := rec.Body.String()
	if !strings.Contains(body, `<script nonce="`+nonce+`">doThing()`) {
		t.Fatalf("inline script not nonced with %q; body: %s", nonce, body)
	}
	if strings.Contains(body, "__ELPASTO_NONCE__") {
		t.Fatal("nonce placeholder leaked into served HTML")
	}

	// A second request must use a different nonce.
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "/", nil))
	m2 := regexp.MustCompile(`'nonce-([A-Za-z0-9+/_-]+)'`).FindStringSubmatch(rec2.Header().Get("Content-Security-Policy"))
	if m2 != nil && m2[1] == nonce {
		t.Fatal("nonce must be unique per request")
	}
}
