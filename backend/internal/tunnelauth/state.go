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
