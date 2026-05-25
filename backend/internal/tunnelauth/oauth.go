package tunnelauth

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	googleAuthURL      = "https://accounts.google.com/o/oauth2/v2/auth"
	googleTokenURL     = "https://oauth2.googleapis.com/token"
	googleTokenInfoURL = "https://oauth2.googleapis.com/tokeninfo"
	defaultTTL         = 30 * 24 * time.Hour // 30 days
)

// Config holds the tunnel auth configuration.
type Config struct {
	ClientID          string
	ClientSecret      string
	AuthSecret        string
	AllowedEmails     map[string]struct{}
	AllowedDomains    map[string]struct{}
	TrustProxyHeaders bool
}

// Handler handles the OAuth browser flow for tunnel CLI authentication.
type Handler struct {
	cfg        Config
	httpClient *http.Client
	logger     *log.Logger
	tokenURL     string // override for testing; defaults to googleTokenURL
	tokenInfoURL string // override for testing; defaults to googleTokenInfoURL
}

// New creates a new tunnel auth Handler.
func New(cfg Config, httpClient *http.Client, logger *log.Logger) (*Handler, error) {
	if cfg.ClientID == "" || cfg.ClientSecret == "" || cfg.AuthSecret == "" {
		return nil, fmt.Errorf("tunnelauth: incomplete configuration")
	}
	if len(cfg.AllowedEmails) == 0 && len(cfg.AllowedDomains) == 0 {
		return nil, fmt.Errorf("tunnelauth: at least one allowed email or domain required")
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 10 * time.Second}
	}
	if logger == nil {
		logger = log.Default()
	}
	return &Handler{cfg: cfg, httpClient: httpClient, logger: logger, tokenURL: googleTokenURL, tokenInfoURL: googleTokenInfoURL}, nil
}

// Enabled returns true if tunnel auth is configured.
func (h *Handler) Enabled() bool {
	return h != nil && h.cfg.ClientID != ""
}

// Start handles GET /api/auth/tunnel/start?port=NNNNN.
// It builds the Google authorize URL and redirects the browser.
func (h *Handler) Start(w http.ResponseWriter, r *http.Request) {
	portStr := r.URL.Query().Get("port")
	if portStr == "" {
		http.Error(w, "missing port parameter", http.StatusBadRequest)
		return
	}

	// Parse port via state minting (validates range).
	state, err := MintState(h.cfg.AuthSecret, mustParsePort(portStr))
	if err != nil {
		http.Error(w, "invalid port parameter", http.StatusBadRequest)
		return
	}

	callbackURL := h.buildCallbackURL(r)

	params := url.Values{
		"client_id":     {h.cfg.ClientID},
		"redirect_uri":  {callbackURL},
		"response_type": {"code"},
		"scope":         {"openid email"},
		"state":         {state},
		"prompt":        {"select_account"},
	}

	http.Redirect(w, r, googleAuthURL+"?"+params.Encode(), http.StatusFound)
}

// Callback handles GET /api/auth/tunnel/callback?code=...&state=...
func (h *Handler) Callback(w http.ResponseWriter, r *http.Request) {
	// Always parse state first to recover the CLI callback port, even on errors.
	// Google preserves the state parameter on both success and error redirects.
	state := r.URL.Query().Get("state")
	port, stateErr := ValidateState(h.cfg.AuthSecret, state)

	// Check for OAuth error from Google (user cancelled, access denied, etc.).
	if errParam := r.URL.Query().Get("error"); errParam != "" {
		if stateErr != nil {
			// Can't redirect — state was also invalid. Show an error page.
			http.Error(w, "Authentication failed: "+errParam, http.StatusBadRequest)
			return
		}
		h.redirectToLocalhost(w, r, port, "", errParam)
		return
	}

	if stateErr != nil {
		http.Error(w, "invalid state", http.StatusBadRequest)
		return
	}

	code := r.URL.Query().Get("code")

	if code == "" {
		h.redirectToLocalhost(w, r, port, "", "missing_code")
		return
	}

	// Exchange authorization code for tokens.
	callbackURL := h.buildCallbackURL(r)
	idToken, err := h.exchangeCode(code, callbackURL)
	if err != nil {
		h.logger.Printf("tunnel auth: code exchange failed: %v", err)
		h.redirectToLocalhost(w, r, port, "", "exchange_failed")
		return
	}

	// Validate the id_token claims.
	claims, err := h.validateIDToken(idToken)
	if err != nil {
		h.logger.Printf("tunnel auth: id_token validation failed: %v", err)
		h.redirectToLocalhost(w, r, port, "", "validation_failed")
		return
	}

	// Authorize: check email/domain allowlist.
	if !h.isAuthorized(claims.Email) {
		h.logger.Printf("tunnel auth: unauthorized email: %s", claims.Email)
		h.redirectToLocalhost(w, r, port, "", "unauthorized")
		return
	}

	// Mint tunnel auth token.
	token, err := Mint(h.cfg.AuthSecret, TokenClaims{
		Sub:   claims.Sub,
		Email: claims.Email,
	}, defaultTTL)
	if err != nil {
		h.logger.Printf("tunnel auth: mint token failed: %v", err)
		h.redirectToLocalhost(w, r, port, "", "internal_error")
		return
	}

	h.logger.Printf("tunnel auth: authorized %s", claims.Email)
	h.redirectToLocalhost(w, r, port, token, "")
}

// ValidateTunnelToken validates a tunnel auth token from an Authorization header.
func (h *Handler) ValidateTunnelToken(raw string) (*TokenClaims, error) {
	return Validate(h.cfg.AuthSecret, raw, time.Now())
}

// redirectToLocalhost sends a redirect to the CLI's local callback listener.
func (h *Handler) redirectToLocalhost(w http.ResponseWriter, r *http.Request, port int, token, errMsg string) {
	if port <= 0 {
		// Can't redirect — port unknown. Show an error page.
		http.Error(w, "Authentication failed: "+errMsg, http.StatusBadRequest)
		return
	}
	u := fmt.Sprintf("http://127.0.0.1:%d/callback", port)
	params := url.Values{}
	if token != "" {
		params.Set("token", token)
	}
	if errMsg != "" {
		params.Set("error", errMsg)
	}
	if len(params) > 0 {
		u += "?" + params.Encode()
	}
	http.Redirect(w, r, u, http.StatusFound)
}

// idTokenClaims are the claims we extract from Google's id_token.
type idTokenClaims struct {
	Iss           string `json:"iss"`
	Aud           string `json:"aud"`
	Sub           string `json:"sub"`
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
	Exp           int64  `json:"exp"`
}

// exchangeCode exchanges an authorization code for an id_token.
func (h *Handler) exchangeCode(code, redirectURI string) (string, error) {
	data := url.Values{
		"code":          {code},
		"client_id":     {h.cfg.ClientID},
		"client_secret": {h.cfg.ClientSecret},
		"redirect_uri":  {redirectURI},
		"grant_type":    {"authorization_code"},
	}

	resp, err := h.httpClient.PostForm(h.tokenURL, data)
	if err != nil {
		return "", fmt.Errorf("token request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return "", fmt.Errorf("read token response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("token endpoint returned %d: %s", resp.StatusCode, body)
	}

	var tokenResp struct {
		IDToken string `json:"id_token"`
	}
	if err := json.Unmarshal(body, &tokenResp); err != nil {
		return "", fmt.Errorf("decode token response: %w", err)
	}
	if tokenResp.IDToken == "" {
		return "", fmt.Errorf("no id_token in response")
	}
	return tokenResp.IDToken, nil
}

// validateIDToken verifies and decodes a Google id_token by calling Google's
// tokeninfo endpoint, which performs full signature verification.
func (h *Handler) validateIDToken(idToken string) (*idTokenClaims, error) {
	resp, err := h.httpClient.Get(h.tokenInfoURL + "?id_token=" + url.QueryEscape(idToken))
	if err != nil {
		return nil, fmt.Errorf("tokeninfo request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 16*1024))
	if err != nil {
		return nil, fmt.Errorf("read tokeninfo response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("tokeninfo returned %d: %s", resp.StatusCode, body)
	}

	var claims idTokenClaims
	if err := json.Unmarshal(body, &claims); err != nil {
		return nil, fmt.Errorf("unmarshal tokeninfo claims: %w", err)
	}

	// Validate issuer.
	if claims.Iss != "https://accounts.google.com" && claims.Iss != "accounts.google.com" {
		return nil, fmt.Errorf("invalid issuer: %s", claims.Iss)
	}

	// Validate audience.
	if claims.Aud != h.cfg.ClientID {
		return nil, fmt.Errorf("invalid audience: %s", claims.Aud)
	}

	// Require verified email.
	if !claims.EmailVerified {
		return nil, fmt.Errorf("email not verified")
	}

	if claims.Email == "" {
		return nil, fmt.Errorf("missing email claim")
	}

	return &claims, nil
}

// isAuthorized checks if the email matches the configured allowlist.
func (h *Handler) isAuthorized(email string) bool {
	email = strings.ToLower(email)

	if _, ok := h.cfg.AllowedEmails[email]; ok {
		return true
	}

	parts := strings.SplitN(email, "@", 2)
	if len(parts) == 2 {
		if _, ok := h.cfg.AllowedDomains[parts[1]]; ok {
			return true
		}
	}

	return false
}

// buildCallbackURL constructs the absolute OAuth callback URL from the request.
// Only trusts proxy headers when TrustProxyHeaders is enabled, matching the
// rest of the server's proxy-trust boundary.
func (h *Handler) buildCallbackURL(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	host := r.Host

	if h.cfg.TrustProxyHeaders {
		if proto := r.Header.Get("X-Forwarded-Proto"); proto != "" {
			scheme = proto
		}
		if fwdHost := r.Header.Get("X-Forwarded-Host"); fwdHost != "" {
			host = fwdHost
		}
	}

	return scheme + "://" + host + "/api/auth/tunnel/callback"
}

// mustParsePort parses a port string. Returns 0 on failure (MintState will reject).
func mustParsePort(s string) int {
	var port int
	fmt.Sscanf(s, "%d", &port)
	return port
}
