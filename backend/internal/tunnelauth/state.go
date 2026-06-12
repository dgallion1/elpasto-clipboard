package tunnelauth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
)

const (
	nonceBytes = 16
	stateParts = 3 // nonce:port:mac
)

// MintState creates a signed OAuth state value encoding the CLI callback port.
// Format: base64url(nonce):port:base64url(hmac-sha256(nonce:port))
func MintState(secret string, port int) (string, error) {
	if secret == "" {
		return "", fmt.Errorf("tunnelauth: empty secret for state")
	}
	if port <= 0 || port > 65535 {
		return "", fmt.Errorf("tunnelauth: invalid port %d", port)
	}

	nonce := make([]byte, nonceBytes)
	// crypto/rand.Read always succeeds (Go 1.24+); panics fatally on
	// catastrophic entropy failure so there is no error to handle.
	rand.Read(nonce)

	nonceB64 := base64.RawURLEncoding.EncodeToString(nonce)
	portStr := strconv.Itoa(port)
	payload := nonceB64 + ":" + portStr

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))

	return payload + ":" + sig, nil
}

// stateNonce returns the random nonce portion of a state value (the first
// colon-separated field), or "" if the state is malformed.
func stateNonce(state string) string {
	if i := strings.IndexByte(state, ':'); i > 0 {
		return state[:i]
	}
	return ""
}

// hmacB64 returns base64url(HMAC-SHA256(secret, label+":"+nonce)).
func hmacB64(secret, label, nonce string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(label + ":" + nonce))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// deriveOIDCNonce derives the OpenID Connect `nonce` for an auth request from
// the state's signed nonce. It is sent in the authorize request and must be
// echoed in the id_token, binding the token to this specific request. Because it
// is HMAC-keyed by the server secret, a client cannot forge a matching pair.
func deriveOIDCNonce(secret, nonce string) string {
	return hmacB64(secret, "elpasto-oidc-nonce", nonce)
}

// derivePKCEVerifier derives the PKCE code_verifier from the state's signed
// nonce. It is secret-keyed and only ever sent server-to-Google in the back
// channel (never in a redirect URL), so it stays confidential even though the
// state nonce it is derived from is public.
func derivePKCEVerifier(secret, nonce string) string {
	return hmacB64(secret, "elpasto-pkce-verifier", nonce)
}

// pkceChallengeS256 computes the S256 code_challenge for a verifier.
func pkceChallengeS256(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// ValidateState verifies the OAuth state and returns the embedded CLI callback port.
func ValidateState(secret, state string) (int, error) {
	if secret == "" {
		return 0, fmt.Errorf("tunnelauth: empty secret for state")
	}

	parts := strings.SplitN(state, ":", stateParts)
	if len(parts) != stateParts {
		return 0, fmt.Errorf("tunnelauth: malformed state")
	}
	nonceB64, portStr, sigB64 := parts[0], parts[1], parts[2]

	// Verify MAC.
	payload := nonceB64 + ":" + portStr
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	expected := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(sigB64), []byte(expected)) {
		return 0, fmt.Errorf("tunnelauth: invalid state signature")
	}

	// Parse port.
	port, err := strconv.Atoi(portStr)
	if err != nil || port <= 0 || port > 65535 {
		return 0, fmt.Errorf("tunnelauth: invalid port in state")
	}

	return port, nil
}
