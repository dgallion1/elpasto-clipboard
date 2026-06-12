package tunnelauth

import (
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func testConfig() Config {
	return Config{
		ClientID:          "test-client-id",
		ClientSecret:      "test-client-secret",
		AuthSecret:        "test-auth-secret-long-enough",
		AllowedEmails:     map[string]struct{}{"alice@example.com": {}},
		AllowedDomains:    map[string]struct{}{"corp.example.com": {}},
		TrustProxyHeaders: true, // simulate production behind a reverse proxy
	}
}

func TestNewHandler(t *testing.T) {
	h, err := New(testConfig(), nil, nil)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if !h.Enabled() {
		t.Fatal("expected enabled")
	}
}

func TestNewHandlerMissingConfig(t *testing.T) {
	cfg := testConfig()
	cfg.ClientID = ""
	_, err := New(cfg, nil, nil)
	if err == nil {
		t.Fatal("expected error for missing client ID")
	}
}

func TestNewHandlerNoAllowlist(t *testing.T) {
	cfg := testConfig()
	cfg.AllowedEmails = nil
	cfg.AllowedDomains = nil
	_, err := New(cfg, nil, nil)
	if err == nil {
		t.Fatal("expected error for empty allowlist")
	}
}

func TestStartRedirectsToGoogle(t *testing.T) {
	h, _ := New(testConfig(), nil, nil)

	req := httptest.NewRequest("GET", "/api/auth/tunnel/start?port=12345", nil)
	req.Host = "example.com"
	req.Header.Set("X-Forwarded-Proto", "https")
	w := httptest.NewRecorder()

	h.Start(w, req)

	if w.Code != http.StatusFound {
		t.Fatalf("status = %d, want 302", w.Code)
	}
	loc := w.Header().Get("Location")
	if !strings.HasPrefix(loc, googleAuthURL) {
		t.Fatalf("redirect should go to Google: %s", loc)
	}
	u, _ := url.Parse(loc)
	if u.Query().Get("client_id") != "test-client-id" {
		t.Fatal("missing client_id in redirect")
	}
	if u.Query().Get("scope") != "openid email" {
		t.Fatal("missing scope")
	}
	if u.Query().Get("state") == "" {
		t.Fatal("missing state")
	}
	if u.Query().Get("redirect_uri") != "https://example.com/api/auth/tunnel/callback" {
		t.Fatalf("unexpected redirect_uri: %s", u.Query().Get("redirect_uri"))
	}
	// OIDC nonce and PKCE challenge must be present and derived from the state.
	sn := stateNonce(u.Query().Get("state"))
	if got, want := u.Query().Get("nonce"), deriveOIDCNonce(testConfig().AuthSecret, sn); got != want {
		t.Fatalf("nonce = %q, want %q", got, want)
	}
	if u.Query().Get("code_challenge_method") != "S256" {
		t.Fatalf("code_challenge_method = %q, want S256", u.Query().Get("code_challenge_method"))
	}
	wantChallenge := pkceChallengeS256(derivePKCEVerifier(testConfig().AuthSecret, sn))
	if got := u.Query().Get("code_challenge"); got != wantChallenge {
		t.Fatalf("code_challenge = %q, want %q", got, wantChallenge)
	}
}

func TestStartMissingPort(t *testing.T) {
	h, _ := New(testConfig(), nil, nil)
	req := httptest.NewRequest("GET", "/api/auth/tunnel/start", nil)
	w := httptest.NewRecorder()
	h.Start(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

// fakeIDToken creates a test JWT with the given claims (no real signature).
func fakeIDToken(claims idTokenClaims) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	payload, _ := json.Marshal(claims)
	payloadB64 := base64.RawURLEncoding.EncodeToString(payload)
	sig := base64.RawURLEncoding.EncodeToString([]byte("fake-signature"))
	return header + "." + payloadB64 + "." + sig
}

// newTestHandlerWithGoogle creates a Handler backed by fake Google token and tokeninfo endpoints.
func newTestHandlerWithGoogle(t *testing.T, cfg Config, idToken string) (*Handler, *httptest.Server) {
	t.Helper()
	mux := http.NewServeMux()
	// Token exchange endpoint: returns the id_token.
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"id_token": idToken})
	})
	// Tokeninfo endpoint: decode the fake JWT payload and return claims.
	mux.HandleFunc("/tokeninfo", func(w http.ResponseWriter, r *http.Request) {
		tok := r.URL.Query().Get("id_token")
		parts := strings.SplitN(tok, ".", 3)
		if len(parts) != 3 {
			http.Error(w, `{"error":"invalid_token"}`, http.StatusBadRequest)
			return
		}
		payload, err := base64.RawURLEncoding.DecodeString(parts[1])
		if err != nil {
			http.Error(w, `{"error":"invalid_token"}`, http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(payload)
	})
	googleSrv := httptest.NewServer(mux)
	t.Cleanup(googleSrv.Close)

	h, err := New(cfg, nil, log.Default())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	h.tokenURL = googleSrv.URL + "/token"
	h.tokenInfoURL = googleSrv.URL + "/tokeninfo"
	return h, googleSrv
}

func TestCallbackSuccess(t *testing.T) {
	cfg := testConfig()
	state, _ := MintState(cfg.AuthSecret, 54321)
	idToken := fakeIDToken(idTokenClaims{
		Iss:           "https://accounts.google.com",
		Aud:           cfg.ClientID,
		Sub:           "google-sub-123",
		Email:         "alice@example.com",
		EmailVerified: true,
		Exp:           time.Now().Add(time.Hour).Unix(),
		Nonce:         deriveOIDCNonce(cfg.AuthSecret, stateNonce(state)),
	})
	h, _ := newTestHandlerWithGoogle(t, cfg, idToken)

	req := httptest.NewRequest("GET",
		fmt.Sprintf("/api/auth/tunnel/callback?code=test-code&state=%s", url.QueryEscape(state)), nil)
	req.Host = "example.com"
	w := httptest.NewRecorder()

	h.Callback(w, req)

	if w.Code != http.StatusFound {
		t.Fatalf("status = %d, want 302; body: %s", w.Code, w.Body.String())
	}
	loc := w.Header().Get("Location")
	if !strings.HasPrefix(loc, "http://127.0.0.1:54321/callback") {
		t.Fatalf("should redirect to localhost: %s", loc)
	}
	u, _ := url.Parse(loc)
	token := u.Query().Get("token")
	if !strings.HasPrefix(token, "ept_") {
		t.Fatalf("expected ept_ token, got: %s", token)
	}
	if u.Query().Get("error") != "" {
		t.Fatalf("unexpected error: %s", u.Query().Get("error"))
	}

	// Validate the minted token.
	claims, err := Validate(cfg.AuthSecret, token, time.Now())
	if err != nil {
		t.Fatalf("Validate minted token: %v", err)
	}
	if claims.Sub != "google-sub-123" || claims.Email != "alice@example.com" {
		t.Fatalf("claims mismatch: %+v", claims)
	}
}

func TestCallbackBadState(t *testing.T) {
	h, _ := New(testConfig(), nil, log.Default())
	req := httptest.NewRequest("GET", "/api/auth/tunnel/callback?code=test&state=bad", nil)
	w := httptest.NewRecorder()
	h.Callback(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestCallbackWrongAudience(t *testing.T) {
	cfg := testConfig()
	idToken := fakeIDToken(idTokenClaims{
		Iss:           "https://accounts.google.com",
		Aud:           "wrong-client-id",
		Sub:           "123",
		Email:         "alice@example.com",
		EmailVerified: true,
		Exp:           time.Now().Add(time.Hour).Unix(),
	})
	h, _ := newTestHandlerWithGoogle(t, cfg, idToken)

	state, _ := MintState(cfg.AuthSecret, 54321)
	req := httptest.NewRequest("GET",
		fmt.Sprintf("/api/auth/tunnel/callback?code=test&state=%s", url.QueryEscape(state)), nil)
	req.Host = "example.com"
	w := httptest.NewRecorder()
	h.Callback(w, req)

	if w.Code != http.StatusFound {
		t.Fatalf("status = %d, want 302", w.Code)
	}
	loc := w.Header().Get("Location")
	u, _ := url.Parse(loc)
	if u.Query().Get("error") != "validation_failed" {
		t.Fatalf("expected validation_failed error, got: %s", u.Query().Get("error"))
	}
}

func TestCallbackUnverifiedEmail(t *testing.T) {
	cfg := testConfig()
	idToken := fakeIDToken(idTokenClaims{
		Iss:           "https://accounts.google.com",
		Aud:           cfg.ClientID,
		Sub:           "123",
		Email:         "alice@example.com",
		EmailVerified: false,
		Exp:           time.Now().Add(time.Hour).Unix(),
	})
	h, _ := newTestHandlerWithGoogle(t, cfg, idToken)

	state, _ := MintState(cfg.AuthSecret, 54321)
	req := httptest.NewRequest("GET",
		fmt.Sprintf("/api/auth/tunnel/callback?code=test&state=%s", url.QueryEscape(state)), nil)
	req.Host = "example.com"
	w := httptest.NewRecorder()
	h.Callback(w, req)

	loc := w.Header().Get("Location")
	u, _ := url.Parse(loc)
	if u.Query().Get("error") != "validation_failed" {
		t.Fatalf("expected validation_failed, got: %s", u.Query().Get("error"))
	}
}

func TestCallbackUnauthorizedEmail(t *testing.T) {
	cfg := testConfig()
	state, _ := MintState(cfg.AuthSecret, 54321)
	idToken := fakeIDToken(idTokenClaims{
		Iss:           "https://accounts.google.com",
		Aud:           cfg.ClientID,
		Sub:           "123",
		Email:         "evil@hacker.com",
		EmailVerified: true,
		Exp:           time.Now().Add(time.Hour).Unix(),
		Nonce:         deriveOIDCNonce(cfg.AuthSecret, stateNonce(state)),
	})
	h, _ := newTestHandlerWithGoogle(t, cfg, idToken)

	req := httptest.NewRequest("GET",
		fmt.Sprintf("/api/auth/tunnel/callback?code=test&state=%s", url.QueryEscape(state)), nil)
	req.Host = "example.com"
	w := httptest.NewRecorder()
	h.Callback(w, req)

	loc := w.Header().Get("Location")
	u, _ := url.Parse(loc)
	if u.Query().Get("error") != "unauthorized" {
		t.Fatalf("expected unauthorized, got: %s", u.Query().Get("error"))
	}
}

func TestCallbackDomainAllowlist(t *testing.T) {
	cfg := testConfig()
	state, _ := MintState(cfg.AuthSecret, 54321)
	idToken := fakeIDToken(idTokenClaims{
		Iss:           "https://accounts.google.com",
		Aud:           cfg.ClientID,
		Sub:           "456",
		Email:         "bob@corp.example.com",
		EmailVerified: true,
		Exp:           time.Now().Add(time.Hour).Unix(),
		Nonce:         deriveOIDCNonce(cfg.AuthSecret, stateNonce(state)),
	})
	h, _ := newTestHandlerWithGoogle(t, cfg, idToken)

	req := httptest.NewRequest("GET",
		fmt.Sprintf("/api/auth/tunnel/callback?code=test&state=%s", url.QueryEscape(state)), nil)
	req.Host = "example.com"
	w := httptest.NewRecorder()
	h.Callback(w, req)

	loc := w.Header().Get("Location")
	u, _ := url.Parse(loc)
	if u.Query().Get("error") != "" {
		t.Fatalf("expected success, got error: %s", u.Query().Get("error"))
	}
	if !strings.HasPrefix(u.Query().Get("token"), "ept_") {
		t.Fatal("expected token in redirect")
	}
}

func TestIsAuthorized(t *testing.T) {
	h, _ := New(testConfig(), nil, nil)

	cases := []struct {
		email string
		want  bool
	}{
		{"alice@example.com", true},
		{"ALICE@EXAMPLE.COM", true},
		{"bob@corp.example.com", true},
		{"eve@evil.com", false},
		{"", false},
	}
	for _, tc := range cases {
		if got := h.isAuthorized(tc.email); got != tc.want {
			t.Errorf("isAuthorized(%q) = %v, want %v", tc.email, got, tc.want)
		}
	}
}

func TestValidateTunnelToken(t *testing.T) {
	cfg := testConfig()
	h, _ := New(cfg, nil, nil)

	token, _ := Mint(cfg.AuthSecret, TokenClaims{Sub: "1", Email: "a@b.com"}, time.Hour)
	claims, err := h.ValidateTunnelToken(token)
	if err != nil {
		t.Fatalf("ValidateTunnelToken: %v", err)
	}
	if claims.Sub != "1" {
		t.Fatalf("sub = %s, want 1", claims.Sub)
	}
}

func TestCallbackOAuthError_WithState(t *testing.T) {
	cfg := testConfig()
	h, _ := New(cfg, nil, log.Default())

	// Google preserves the state param on error redirects. The callback should
	// parse the port from state and redirect the error to the CLI listener.
	state, _ := MintState(cfg.AuthSecret, 54321)
	req := httptest.NewRequest("GET",
		fmt.Sprintf("/api/auth/tunnel/callback?error=access_denied&state=%s", url.QueryEscape(state)), nil)
	w := httptest.NewRecorder()
	h.Callback(w, req)

	if w.Code != http.StatusFound {
		t.Fatalf("status = %d, want 302", w.Code)
	}
	loc := w.Header().Get("Location")
	if !strings.HasPrefix(loc, "http://127.0.0.1:54321/callback") {
		t.Fatalf("should redirect to localhost: %s", loc)
	}
	u, _ := url.Parse(loc)
	if u.Query().Get("error") != "access_denied" {
		t.Fatalf("expected access_denied error, got: %s", u.Query().Get("error"))
	}
}

func TestBuildCallbackURL_DirectHTTP(t *testing.T) {
	// When TrustProxyHeaders is false and no TLS, scheme should be http.
	cfg := testConfig()
	cfg.TrustProxyHeaders = false
	h, _ := New(cfg, nil, nil)

	req := httptest.NewRequest("GET", "/api/auth/tunnel/start", nil)
	req.Host = "127.0.0.1:8080"
	req.Header.Set("X-Forwarded-Proto", "https") // should be ignored

	got := h.buildCallbackURL(req)
	want := "http://127.0.0.1:8080/api/auth/tunnel/callback"
	if got != want {
		t.Fatalf("buildCallbackURL = %q, want %q", got, want)
	}
}

func TestBuildCallbackURL_ProxyTrusted(t *testing.T) {
	cfg := testConfig() // TrustProxyHeaders=true
	h, _ := New(cfg, nil, nil)

	req := httptest.NewRequest("GET", "/api/auth/tunnel/start", nil)
	req.Host = "internal:3001"
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("X-Forwarded-Host", "example.com")

	got := h.buildCallbackURL(req)
	want := "https://example.com/api/auth/tunnel/callback"
	if got != want {
		t.Fatalf("buildCallbackURL = %q, want %q", got, want)
	}
}

func TestCallbackOAuthError_NoState(t *testing.T) {
	h, _ := New(testConfig(), nil, log.Default())
	// No state at all (shouldn't happen, but defensive).
	req := httptest.NewRequest("GET", "/api/auth/tunnel/callback?error=access_denied", nil)
	w := httptest.NewRecorder()
	h.Callback(w, req)
	// Can't redirect without valid state — should show error page.
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestCallbackMissingCode(t *testing.T) {
	cfg := testConfig()
	h, _ := New(cfg, nil, log.Default())

	state, _ := MintState(cfg.AuthSecret, 54321)
	req := httptest.NewRequest("GET",
		fmt.Sprintf("/api/auth/tunnel/callback?state=%s", url.QueryEscape(state)), nil)
	req.Host = "example.com"
	w := httptest.NewRecorder()
	h.Callback(w, req)

	if w.Code != http.StatusFound {
		t.Fatalf("status = %d, want 302", w.Code)
	}
	loc := w.Header().Get("Location")
	u, _ := url.Parse(loc)
	if u.Query().Get("error") != "missing_code" {
		t.Fatalf("expected missing_code error, got: %s", u.Query().Get("error"))
	}
}

func TestCallbackExchangeCodeFailure(t *testing.T) {
	cfg := testConfig()

	// Set up a fake Google server that returns an error on token exchange.
	mux := http.NewServeMux()
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"invalid_grant"}`))
	})
	googleSrv := httptest.NewServer(mux)
	defer googleSrv.Close()

	h, _ := New(cfg, nil, log.Default())
	h.tokenURL = googleSrv.URL + "/token"

	state, _ := MintState(cfg.AuthSecret, 54321)
	req := httptest.NewRequest("GET",
		fmt.Sprintf("/api/auth/tunnel/callback?code=bad-code&state=%s", url.QueryEscape(state)), nil)
	req.Host = "example.com"
	w := httptest.NewRecorder()
	h.Callback(w, req)

	loc := w.Header().Get("Location")
	u, _ := url.Parse(loc)
	if u.Query().Get("error") != "exchange_failed" {
		t.Fatalf("expected exchange_failed, got: %s", u.Query().Get("error"))
	}
}

func TestCallbackExchangeNoIDToken(t *testing.T) {
	cfg := testConfig()

	mux := http.NewServeMux()
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"access_token": "at"})
	})
	googleSrv := httptest.NewServer(mux)
	defer googleSrv.Close()

	h, _ := New(cfg, nil, log.Default())
	h.tokenURL = googleSrv.URL + "/token"

	state, _ := MintState(cfg.AuthSecret, 54321)
	req := httptest.NewRequest("GET",
		fmt.Sprintf("/api/auth/tunnel/callback?code=test-code&state=%s", url.QueryEscape(state)), nil)
	req.Host = "example.com"
	w := httptest.NewRecorder()
	h.Callback(w, req)

	loc := w.Header().Get("Location")
	u, _ := url.Parse(loc)
	if u.Query().Get("error") != "exchange_failed" {
		t.Fatalf("expected exchange_failed, got: %s", u.Query().Get("error"))
	}
}

func TestCallbackTokenInfoFailure(t *testing.T) {
	cfg := testConfig()
	idToken := fakeIDToken(idTokenClaims{
		Iss:           "https://accounts.google.com",
		Aud:           cfg.ClientID,
		Sub:           "123",
		Email:         "alice@example.com",
		EmailVerified: true,
		Exp:           time.Now().Add(time.Hour).Unix(),
	})

	mux := http.NewServeMux()
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"id_token": idToken})
	})
	mux.HandleFunc("/tokeninfo", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"invalid_token"}`))
	})
	googleSrv := httptest.NewServer(mux)
	defer googleSrv.Close()

	h, _ := New(cfg, nil, log.Default())
	h.tokenURL = googleSrv.URL + "/token"
	h.tokenInfoURL = googleSrv.URL + "/tokeninfo"

	state, _ := MintState(cfg.AuthSecret, 54321)
	req := httptest.NewRequest("GET",
		fmt.Sprintf("/api/auth/tunnel/callback?code=test-code&state=%s", url.QueryEscape(state)), nil)
	req.Host = "example.com"
	w := httptest.NewRecorder()
	h.Callback(w, req)

	loc := w.Header().Get("Location")
	u, _ := url.Parse(loc)
	if u.Query().Get("error") != "validation_failed" {
		t.Fatalf("expected validation_failed, got: %s", u.Query().Get("error"))
	}
}

func TestCallbackInvalidIssuer(t *testing.T) {
	cfg := testConfig()
	idToken := fakeIDToken(idTokenClaims{
		Iss:           "https://evil.example.com",
		Aud:           cfg.ClientID,
		Sub:           "123",
		Email:         "alice@example.com",
		EmailVerified: true,
		Exp:           time.Now().Add(time.Hour).Unix(),
	})
	h, _ := newTestHandlerWithGoogle(t, cfg, idToken)

	state, _ := MintState(cfg.AuthSecret, 54321)
	req := httptest.NewRequest("GET",
		fmt.Sprintf("/api/auth/tunnel/callback?code=test&state=%s", url.QueryEscape(state)), nil)
	req.Host = "example.com"
	w := httptest.NewRecorder()
	h.Callback(w, req)

	loc := w.Header().Get("Location")
	u, _ := url.Parse(loc)
	if u.Query().Get("error") != "validation_failed" {
		t.Fatalf("expected validation_failed, got: %s", u.Query().Get("error"))
	}
}

func TestCallbackMissingEmail(t *testing.T) {
	cfg := testConfig()
	idToken := fakeIDToken(idTokenClaims{
		Iss:           "https://accounts.google.com",
		Aud:           cfg.ClientID,
		Sub:           "123",
		Email:         "",
		EmailVerified: true,
		Exp:           time.Now().Add(time.Hour).Unix(),
	})
	h, _ := newTestHandlerWithGoogle(t, cfg, idToken)

	state, _ := MintState(cfg.AuthSecret, 54321)
	req := httptest.NewRequest("GET",
		fmt.Sprintf("/api/auth/tunnel/callback?code=test&state=%s", url.QueryEscape(state)), nil)
	req.Host = "example.com"
	w := httptest.NewRecorder()
	h.Callback(w, req)

	loc := w.Header().Get("Location")
	u, _ := url.Parse(loc)
	if u.Query().Get("error") != "validation_failed" {
		t.Fatalf("expected validation_failed, got: %s", u.Query().Get("error"))
	}
}

func TestNilHandlerDisabled(t *testing.T) {
	var h *Handler
	if h.Enabled() {
		t.Fatal("nil handler should not be enabled")
	}
}

func TestHandlerDisabledWithoutClientID(t *testing.T) {
	// Handler with empty ClientID in cfg (but still a non-nil handler)
	cfg := testConfig()
	h, _ := New(cfg, nil, nil)
	// Clear ClientID after creation to test Enabled check
	h.cfg.ClientID = ""
	if h.Enabled() {
		t.Fatal("handler with empty ClientID should not be enabled")
	}
}

func TestStartInvalidPort(t *testing.T) {
	h, _ := New(testConfig(), nil, nil)
	req := httptest.NewRequest("GET", "/api/auth/tunnel/start?port=abc", nil)
	w := httptest.NewRecorder()
	h.Start(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestStartZeroPort(t *testing.T) {
	h, _ := New(testConfig(), nil, nil)
	req := httptest.NewRequest("GET", "/api/auth/tunnel/start?port=0", nil)
	w := httptest.NewRecorder()
	h.Start(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestBuildCallbackURL_NoProxy(t *testing.T) {
	cfg := testConfig()
	cfg.TrustProxyHeaders = false
	h, _ := New(cfg, nil, nil)

	req := httptest.NewRequest("GET", "/test", nil)
	req.Host = "localhost:8080"
	// Proxy headers should be ignored.
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("X-Forwarded-Host", "example.com")

	got := h.buildCallbackURL(req)
	if got != "http://localhost:8080/api/auth/tunnel/callback" {
		t.Fatalf("buildCallbackURL = %q, want http://localhost:8080/api/auth/tunnel/callback", got)
	}
}

func TestRedirectToLocalhostBadPort(t *testing.T) {
	h, _ := New(testConfig(), nil, log.Default())
	req := httptest.NewRequest("GET", "/test", nil)
	w := httptest.NewRecorder()
	h.redirectToLocalhost(w, req, 0, "", "some_error")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestRedirectToLocalhostWithToken(t *testing.T) {
	h, _ := New(testConfig(), nil, log.Default())
	req := httptest.NewRequest("GET", "/test", nil)
	w := httptest.NewRecorder()
	h.redirectToLocalhost(w, req, 54321, "ept_mytoken", "")
	if w.Code != http.StatusFound {
		t.Fatalf("status = %d, want 302", w.Code)
	}
	loc := w.Header().Get("Location")
	u, _ := url.Parse(loc)
	if u.Query().Get("token") != "ept_mytoken" {
		t.Fatalf("expected token=ept_mytoken, got: %s", u.Query().Get("token"))
	}
	if u.Query().Get("error") != "" {
		t.Fatalf("expected no error, got: %s", u.Query().Get("error"))
	}
}

func TestIsAuthorizedCaseInsensitive(t *testing.T) {
	h, _ := New(testConfig(), nil, nil)
	// Domain check is case insensitive via ToLower.
	if !h.isAuthorized("BOB@CORP.EXAMPLE.COM") {
		t.Fatal("expected uppercase domain email to be authorized")
	}
}

func TestIsAuthorizedNoAtSign(t *testing.T) {
	h, _ := New(testConfig(), nil, nil)
	if h.isAuthorized("noatsign") {
		t.Fatal("email without @ should not be authorized")
	}
}

func TestNewHandlerMissingClientSecret(t *testing.T) {
	cfg := testConfig()
	cfg.ClientSecret = ""
	_, err := New(cfg, nil, nil)
	if err == nil {
		t.Fatal("expected error for missing client secret")
	}
}

func TestNewHandlerMissingAuthSecret(t *testing.T) {
	cfg := testConfig()
	cfg.AuthSecret = ""
	_, err := New(cfg, nil, nil)
	if err == nil {
		t.Fatal("expected error for missing auth secret")
	}
}

func TestValidateIDTokenAlternateIssuer(t *testing.T) {
	// Google sometimes returns "accounts.google.com" without the https:// prefix.
	cfg := testConfig()
	state, _ := MintState(cfg.AuthSecret, 54321)
	idToken := fakeIDToken(idTokenClaims{
		Iss:           "accounts.google.com",
		Aud:           cfg.ClientID,
		Sub:           "123",
		Email:         "alice@example.com",
		EmailVerified: true,
		Exp:           time.Now().Add(time.Hour).Unix(),
		Nonce:         deriveOIDCNonce(cfg.AuthSecret, stateNonce(state)),
	})
	h, _ := newTestHandlerWithGoogle(t, cfg, idToken)

	req := httptest.NewRequest("GET",
		fmt.Sprintf("/api/auth/tunnel/callback?code=test&state=%s", url.QueryEscape(state)), nil)
	req.Host = "example.com"
	w := httptest.NewRecorder()
	h.Callback(w, req)

	loc := w.Header().Get("Location")
	u, _ := url.Parse(loc)
	if u.Query().Get("error") != "" {
		t.Fatalf("expected success with alternate issuer, got error: %s", u.Query().Get("error"))
	}
	if !strings.HasPrefix(u.Query().Get("token"), "ept_") {
		t.Fatal("expected token in redirect")
	}
}

func TestMustParsePort(t *testing.T) {
	if p := mustParsePort("12345"); p != 12345 {
		t.Fatalf("mustParsePort(12345) = %d", p)
	}
	if p := mustParsePort("abc"); p != 0 {
		t.Fatalf("mustParsePort(abc) = %d, want 0", p)
	}
	if p := mustParsePort(""); p != 0 {
		t.Fatalf("mustParsePort('') = %d, want 0", p)
	}
}

func TestExchangeCode_HTTPClientError(t *testing.T) {
	cfg := testConfig()
	h, _ := New(cfg, nil, log.Default())
	// Point tokenURL at an invalid URL to trigger HTTP client error.
	h.tokenURL = "http://127.0.0.1:0/nonexistent"

	_, err := h.exchangeCode("some-code", "http://localhost/callback", "test-verifier")
	if err == nil {
		t.Fatal("expected error from HTTP client failure")
	}
	if !strings.Contains(err.Error(), "token request") {
		t.Fatalf("expected 'token request' in error, got: %v", err)
	}
}

func TestExchangeCode_Non200Response(t *testing.T) {
	cfg := testConfig()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte("server error"))
	}))
	defer srv.Close()

	h, _ := New(cfg, nil, log.Default())
	h.tokenURL = srv.URL

	_, err := h.exchangeCode("some-code", "http://localhost/callback", "test-verifier")
	if err == nil {
		t.Fatal("expected error for non-200 response")
	}
	if !strings.Contains(err.Error(), "500") {
		t.Fatalf("expected status code in error, got: %v", err)
	}
}

func TestExchangeCode_InvalidJSON(t *testing.T) {
	cfg := testConfig()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("this is not json"))
	}))
	defer srv.Close()

	h, _ := New(cfg, nil, log.Default())
	h.tokenURL = srv.URL

	_, err := h.exchangeCode("some-code", "http://localhost/callback", "test-verifier")
	if err == nil {
		t.Fatal("expected error for invalid JSON response")
	}
	if !strings.Contains(err.Error(), "decode token response") {
		t.Fatalf("expected 'decode token response' in error, got: %v", err)
	}
}

func TestExchangeCode_EmptyIDToken(t *testing.T) {
	cfg := testConfig()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"access_token":"at","id_token":""}`))
	}))
	defer srv.Close()

	h, _ := New(cfg, nil, log.Default())
	h.tokenURL = srv.URL

	_, err := h.exchangeCode("some-code", "http://localhost/callback", "test-verifier")
	if err == nil {
		t.Fatal("expected error for empty id_token")
	}
	if !strings.Contains(err.Error(), "no id_token") {
		t.Fatalf("expected 'no id_token' in error, got: %v", err)
	}
}

func TestValidateIDToken_HTTPClientError(t *testing.T) {
	cfg := testConfig()
	h, _ := New(cfg, nil, log.Default())
	// Point tokenInfoURL at an invalid URL.
	h.tokenInfoURL = "http://127.0.0.1:0/nonexistent"

	_, err := h.validateIDToken("fake-token", "")
	if err == nil {
		t.Fatal("expected error from HTTP client failure")
	}
	if !strings.Contains(err.Error(), "tokeninfo request") {
		t.Fatalf("expected 'tokeninfo request' in error, got: %v", err)
	}
}

func TestValidateIDToken_InvalidJSON(t *testing.T) {
	cfg := testConfig()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("not json at all"))
	}))
	defer srv.Close()

	h, _ := New(cfg, nil, log.Default())
	h.tokenInfoURL = srv.URL

	_, err := h.validateIDToken("fake-token", "")
	if err == nil {
		t.Fatal("expected error for invalid JSON from tokeninfo")
	}
	if !strings.Contains(err.Error(), "unmarshal tokeninfo") {
		t.Fatalf("expected 'unmarshal tokeninfo' in error, got: %v", err)
	}
}

func TestBuildCallbackURL_TLS(t *testing.T) {
	// When the request has TLS set and TrustProxyHeaders is false, scheme is https.
	cfg := testConfig()
	cfg.TrustProxyHeaders = false
	h, _ := New(cfg, nil, nil)

	req := httptest.NewRequest("GET", "/test", nil)
	req.Host = "example.com"
	// httptest.NewRequest doesn't set TLS, simulate it.
	req.TLS = &tls.ConnectionState{}

	got := h.buildCallbackURL(req)
	want := "https://example.com/api/auth/tunnel/callback"
	if got != want {
		t.Fatalf("buildCallbackURL = %q, want %q", got, want)
	}
}

func TestValidateIDToken_Non200Response(t *testing.T) {
	cfg := testConfig()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte("server error"))
	}))
	defer srv.Close()

	h, _ := New(cfg, nil, log.Default())
	h.tokenInfoURL = srv.URL

	_, err := h.validateIDToken("fake-token", "")
	if err == nil {
		t.Fatal("expected error for non-200 response")
	}
	if !strings.Contains(err.Error(), "500") {
		t.Fatalf("expected status code in error, got: %v", err)
	}
}

func TestCallbackOAuthError_ValidStateWithError(t *testing.T) {
	// Test the path where Google sends error=server_error with a valid state.
	cfg := testConfig()
	h, _ := New(cfg, nil, log.Default())

	state, _ := MintState(cfg.AuthSecret, 54321)
	req := httptest.NewRequest("GET",
		fmt.Sprintf("/api/auth/tunnel/callback?error=server_error&state=%s", state), nil)
	w := httptest.NewRecorder()
	h.Callback(w, req)

	if w.Code != http.StatusFound {
		t.Fatalf("status = %d, want 302", w.Code)
	}
	loc := w.Header().Get("Location")
	if !strings.HasPrefix(loc, "http://127.0.0.1:54321/callback") {
		t.Fatalf("should redirect to localhost: %s", loc)
	}
	u, _ := url.Parse(loc)
	if u.Query().Get("error") != "server_error" {
		t.Fatalf("expected server_error, got: %s", u.Query().Get("error"))
	}
}

func TestRedirectToLocalhostNoParams(t *testing.T) {
	// When both token and errMsg are empty, no query params should be added.
	h, _ := New(testConfig(), nil, log.Default())
	req := httptest.NewRequest("GET", "/test", nil)
	w := httptest.NewRecorder()
	h.redirectToLocalhost(w, req, 54321, "", "")
	if w.Code != http.StatusFound {
		t.Fatalf("status = %d, want 302", w.Code)
	}
	loc := w.Header().Get("Location")
	if strings.Contains(loc, "?") {
		t.Errorf("expected no query params, got: %s", loc)
	}
}

func TestCallbackExchangeCodeConnectionError(t *testing.T) {
	// Verify the path where the token endpoint HTTP request itself fails.
	cfg := testConfig()
	h, _ := New(cfg, nil, log.Default())
	h.tokenURL = "http://127.0.0.1:0/nonexistent" // unreachable

	state, _ := MintState(cfg.AuthSecret, 54321)
	req := httptest.NewRequest("GET",
		fmt.Sprintf("/api/auth/tunnel/callback?code=test&state=%s", state), nil)
	req.Host = "example.com"
	w := httptest.NewRecorder()
	h.Callback(w, req)

	loc := w.Header().Get("Location")
	u, _ := url.Parse(loc)
	if u.Query().Get("error") != "exchange_failed" {
		t.Fatalf("expected exchange_failed, got: %s", u.Query().Get("error"))
	}
}

func TestValidateIDTokenConnectionError(t *testing.T) {
	cfg := testConfig()
	h, _ := New(cfg, nil, log.Default())
	h.tokenInfoURL = "http://127.0.0.1:0/nonexistent"

	_, err := h.validateIDToken("fake-token", "")
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "tokeninfo request") {
		t.Fatalf("expected 'tokeninfo request' in error, got: %v", err)
	}
}

// errReader is an io.Reader that always returns an error.
type errReader struct{ err error }

func (r *errReader) Read([]byte) (int, error) { return 0, r.err }

// errRoundTripper returns a response with an error-producing body.
type errRoundTripper struct{ bodyErr error }

func (rt *errRoundTripper) RoundTrip(*http.Request) (*http.Response, error) {
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(&errReader{err: rt.bodyErr}),
		Header:     make(http.Header),
	}, nil
}

func TestExchangeCode_BodyReadError(t *testing.T) {
	cfg := testConfig()
	h, _ := New(cfg, &http.Client{
		Transport: &errRoundTripper{bodyErr: fmt.Errorf("connection reset")},
	}, log.Default())
	h.tokenURL = "http://fake-google.test/token"

	_, err := h.exchangeCode("some-code", "http://localhost/callback", "test-verifier")
	if err == nil {
		t.Fatal("expected error from body read failure")
	}
	if !strings.Contains(err.Error(), "read token response") {
		t.Fatalf("expected 'read token response' in error, got: %v", err)
	}
}

func TestValidateIDToken_BodyReadError(t *testing.T) {
	cfg := testConfig()
	h, _ := New(cfg, &http.Client{
		Transport: &errRoundTripper{bodyErr: fmt.Errorf("connection reset")},
	}, log.Default())
	h.tokenInfoURL = "http://fake-google.test/tokeninfo"

	_, err := h.validateIDToken("fake-token", "")
	if err == nil {
		t.Fatal("expected error from body read failure")
	}
	if !strings.Contains(err.Error(), "read tokeninfo response") {
		t.Fatalf("expected 'read tokeninfo response' in error, got: %v", err)
	}
}

func TestCallbackMintFailure(t *testing.T) {
	// To reach the Mint failure inside Callback, we need:
	// 1. ValidateState to pass (requires correct secret)
	// 2. exchangeCode to pass (returns valid id_token)
	// 3. validateIDToken to pass (returns valid claims)
	// 4. isAuthorized to pass (email in allowlist)
	// 5. Mint to fail
	//
	// Mint only fails with empty secret. We can't have ValidateState pass with
	// empty secret. Instead, we sabotage the secret AFTER ValidateState runs
	// by using a custom handler that clears the secret at the right moment.
	//
	// The simplest approach: use a token endpoint that is slow enough for us
	// to clear the secret concurrently. But that's racy.
	//
	// Better: override the Callback to test the Mint branch via the
	// exchangeCode/validateIDToken integration. Actually, the cleanest way is
	// to create a fake Google server where the token endpoint clears h.cfg.AuthSecret
	// as a side effect before returning the id_token.
	cfg := testConfig()
	state, _ := MintState(cfg.AuthSecret, 54321)
	idToken := fakeIDToken(idTokenClaims{
		Iss:           "https://accounts.google.com",
		Aud:           cfg.ClientID,
		Sub:           "google-sub-123",
		Email:         "alice@example.com",
		EmailVerified: true,
		Exp:           time.Now().Add(time.Hour).Unix(),
		Nonce:         deriveOIDCNonce(cfg.AuthSecret, stateNonce(state)),
	})

	h, err := New(cfg, nil, log.Default())
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// Create a fake Google server that sabotages the auth secret when the
	// token endpoint is called (after ValidateState has already passed).
	mux := http.NewServeMux()
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		// Sabotage: clear the auth secret so Mint will fail.
		h.cfg.AuthSecret = ""
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"id_token": idToken})
	})
	mux.HandleFunc("/tokeninfo", func(w http.ResponseWriter, r *http.Request) {
		tok := r.URL.Query().Get("id_token")
		parts := strings.SplitN(tok, ".", 3)
		if len(parts) != 3 {
			http.Error(w, `{"error":"invalid_token"}`, http.StatusBadRequest)
			return
		}
		payload, err := base64.RawURLEncoding.DecodeString(parts[1])
		if err != nil {
			http.Error(w, `{"error":"invalid_token"}`, http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(payload)
	})
	googleSrv := httptest.NewServer(mux)
	defer googleSrv.Close()

	h.tokenURL = googleSrv.URL + "/token"
	h.tokenInfoURL = googleSrv.URL + "/tokeninfo"

	req := httptest.NewRequest("GET",
		fmt.Sprintf("/api/auth/tunnel/callback?code=test-code&state=%s", url.QueryEscape(state)), nil)
	req.Host = "example.com"
	w := httptest.NewRecorder()
	h.Callback(w, req)

	if w.Code != http.StatusFound {
		t.Fatalf("status = %d, want 302; body: %s", w.Code, w.Body.String())
	}
	loc := w.Header().Get("Location")
	u, _ := url.Parse(loc)
	if u.Query().Get("error") != "internal_error" {
		t.Fatalf("expected internal_error, got: %s", u.Query().Get("error"))
	}
}

func TestCallbackRejectsNonceMismatch(t *testing.T) {
	// An id_token whose nonce does not match the one bound to this request must
	// be rejected (defeats id_token replay/injection).
	cfg := testConfig()
	state, _ := MintState(cfg.AuthSecret, 54321)
	idToken := fakeIDToken(idTokenClaims{
		Iss:           "https://accounts.google.com",
		Aud:           cfg.ClientID,
		Sub:           "google-sub-123",
		Email:         "alice@example.com",
		EmailVerified: true,
		Exp:           time.Now().Add(time.Hour).Unix(),
		Nonce:         "attacker-supplied-nonce",
	})
	h, _ := newTestHandlerWithGoogle(t, cfg, idToken)

	req := httptest.NewRequest("GET",
		fmt.Sprintf("/api/auth/tunnel/callback?code=test&state=%s", url.QueryEscape(state)), nil)
	req.Host = "example.com"
	w := httptest.NewRecorder()
	h.Callback(w, req)

	u, _ := url.Parse(w.Header().Get("Location"))
	if u.Query().Get("error") != "validation_failed" {
		t.Fatalf("expected validation_failed on nonce mismatch, got: %s", u.Query().Get("error"))
	}
	if u.Query().Get("token") != "" {
		t.Fatal("no token should be issued on nonce mismatch")
	}
}

func TestCallbackSendsPKCEVerifier(t *testing.T) {
	cfg := testConfig()
	state, _ := MintState(cfg.AuthSecret, 54321)
	wantVerifier := derivePKCEVerifier(cfg.AuthSecret, stateNonce(state))

	var gotVerifier string
	idToken := fakeIDToken(idTokenClaims{
		Iss: "https://accounts.google.com", Aud: cfg.ClientID, Sub: "s", Email: "alice@example.com",
		EmailVerified: true, Exp: time.Now().Add(time.Hour).Unix(),
		Nonce: deriveOIDCNonce(cfg.AuthSecret, stateNonce(state)),
	})
	mux := http.NewServeMux()
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		gotVerifier = r.Form.Get("code_verifier")
		json.NewEncoder(w).Encode(map[string]string{"id_token": idToken})
	})
	mux.HandleFunc("/tokeninfo", func(w http.ResponseWriter, r *http.Request) {
		parts := strings.SplitN(r.URL.Query().Get("id_token"), ".", 3)
		payload, _ := base64.RawURLEncoding.DecodeString(parts[1])
		w.Write(payload)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	h, _ := New(cfg, nil, log.Default())
	h.tokenURL = srv.URL + "/token"
	h.tokenInfoURL = srv.URL + "/tokeninfo"

	req := httptest.NewRequest("GET",
		fmt.Sprintf("/api/auth/tunnel/callback?code=test&state=%s", url.QueryEscape(state)), nil)
	req.Host = "example.com"
	h.Callback(httptest.NewRecorder(), req)

	if gotVerifier != wantVerifier {
		t.Fatalf("token endpoint received code_verifier %q, want %q", gotVerifier, wantVerifier)
	}
}

func TestBuildCallbackURL_PinnedToPublicBaseURL(t *testing.T) {
	// When PublicBaseURL is configured, the callback host is pinned and a spoofed
	// X-Forwarded-Host (even with proxy headers trusted) cannot redirect OAuth.
	cfg := testConfig()
	cfg.TrustProxyHeaders = true
	cfg.PublicBaseURL = "https://elpasto.app"
	h, _ := New(cfg, nil, nil)

	req := httptest.NewRequest("GET", "/api/auth/tunnel/start", nil)
	req.Host = "example.com"
	req.Header.Set("X-Forwarded-Host", "evil.attacker.test")
	req.Header.Set("X-Forwarded-Proto", "http")

	got := h.buildCallbackURL(req)
	want := "https://elpasto.app/api/auth/tunnel/callback"
	if got != want {
		t.Fatalf("buildCallbackURL = %q, want pinned %q", got, want)
	}
}

func TestBuildCallbackURL_PinnedTrimsTrailingSlash(t *testing.T) {
	cfg := testConfig()
	cfg.PublicBaseURL = "https://elpasto.app/"
	h, _ := New(cfg, nil, nil)
	req := httptest.NewRequest("GET", "/api/auth/tunnel/start", nil)
	req.Host = "example.com"
	if got, want := h.buildCallbackURL(req), "https://elpasto.app/api/auth/tunnel/callback"; got != want {
		t.Fatalf("buildCallbackURL = %q, want %q", got, want)
	}
}
