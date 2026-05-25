package tunnelauth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

const tokenPrefix = "ept_"

// TokenClaims are the claims embedded in a tunnel auth token.
type TokenClaims struct {
	Sub   string `json:"sub"`   // Google subject (stable user ID)
	Email string `json:"email"` // Google email (for allowlist checks and logging)
	Exp   int64  `json:"exp"`   // Unix timestamp
}

// Mint creates a signed tunnel auth token with the given claims and TTL.
// Format: ept_<base64url(json(claims))>.<base64url(hmac-sha256)>
func Mint(secret string, claims TokenClaims, ttl time.Duration) (string, error) {
	if secret == "" {
		return "", fmt.Errorf("tunnelauth: empty secret")
	}
	claims.Exp = time.Now().Add(ttl).Unix()
	// TokenClaims contains only string and int64 fields — json.Marshal
	// is guaranteed to succeed for this type.
	payload, _ := json.Marshal(claims)
	payloadB64 := base64.RawURLEncoding.EncodeToString(payload)
	sig := sign(secret, payloadB64)
	return tokenPrefix + payloadB64 + "." + sig, nil
}

// Validate parses and verifies a tunnel auth token. Returns the claims if valid.
func Validate(secret, raw string, now time.Time) (*TokenClaims, error) {
	if secret == "" {
		return nil, fmt.Errorf("tunnelauth: empty secret")
	}
	if !strings.HasPrefix(raw, tokenPrefix) {
		return nil, fmt.Errorf("tunnelauth: missing prefix")
	}
	raw = raw[len(tokenPrefix):]

	parts := strings.SplitN(raw, ".", 2)
	if len(parts) != 2 {
		return nil, fmt.Errorf("tunnelauth: malformed token")
	}
	payloadB64, sigB64 := parts[0], parts[1]

	// Verify signature.
	expected := sign(secret, payloadB64)
	if !hmac.Equal([]byte(sigB64), []byte(expected)) {
		return nil, fmt.Errorf("tunnelauth: invalid signature")
	}

	// Decode claims.
	payload, err := base64.RawURLEncoding.DecodeString(payloadB64)
	if err != nil {
		return nil, fmt.Errorf("tunnelauth: decode payload: %w", err)
	}
	var claims TokenClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil, fmt.Errorf("tunnelauth: unmarshal claims: %w", err)
	}

	// Check expiry.
	if now.Unix() > claims.Exp {
		return nil, fmt.Errorf("tunnelauth: token expired")
	}

	return &claims, nil
}

func sign(secret, payload string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
