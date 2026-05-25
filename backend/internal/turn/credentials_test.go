package turn

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestGenerateCredentials(t *testing.T) {
	secret := "test-secret"
	token := "alpha-bravo-charlie-delta-echo"
	expiresAt := time.Now().Add(48 * time.Hour)
	server := "turn.example.com"

	creds := GenerateCredentials(secret, token, expiresAt, server)

	if len(creds.URLs) != 2 {
		t.Fatalf("expected 2 URLs, got %d", len(creds.URLs))
	}
	if creds.URLs[0] != "turn:turn.example.com:3478?transport=udp" {
		t.Fatalf("unexpected UDP URL: %s", creds.URLs[0])
	}
	if creds.URLs[1] != "turn:turn.example.com:3478?transport=tcp" {
		t.Fatalf("unexpected TCP URL: %s", creds.URLs[1])
	}

	// Username should NOT contain the raw session token.
	if strings.Contains(creds.Username, token) {
		t.Fatalf("username contains raw session token: %s", creds.Username)
	}

	// Username format: "<unix_ts>:<opaque_id>"
	parts := strings.SplitN(creds.Username, ":", 2)
	if len(parts) != 2 {
		t.Fatalf("expected username format 'ts:id', got %q", creds.Username)
	}

	// Verify the opaque ID is an HMAC of the session token.
	idMac := hmac.New(sha1.New, []byte(secret))
	idMac.Write([]byte(token))
	expectedID := base64.RawURLEncoding.EncodeToString(idMac.Sum(nil))
	if parts[1] != expectedID {
		t.Fatalf("opaque ID mismatch: got %q, want %q", parts[1], expectedID)
	}

	// Verify credential is HMAC of the full username.
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(creds.Username))
	expectedCred := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if creds.Credential != expectedCred {
		t.Fatalf("expected credential %q, got %q", expectedCred, creds.Credential)
	}
}

func TestGenerateCredentialsCapsAt10m(t *testing.T) {
	secret := "test-secret"
	token := "test-token"
	// Session expiry is 10 years out — credential must be capped at ~10m.
	expiresAt := time.Now().Add(10 * 365 * 24 * time.Hour)

	creds := GenerateCredentials(secret, token, expiresAt, "turn.example.com")

	parts := strings.SplitN(creds.Username, ":", 2)
	if len(parts) != 2 {
		t.Fatalf("bad username format: %q", creds.Username)
	}
	var ts int64
	fmt.Sscanf(parts[0], "%d", &ts)

	credExpiry := time.Unix(ts, 0)
	untilExpiry := time.Until(credExpiry)

	if untilExpiry > 11*time.Minute {
		t.Fatalf("credential expiry too far out: %s (expected ~10m)", untilExpiry)
	}
	if untilExpiry < 9*time.Minute {
		t.Fatalf("credential expiry too soon: %s (expected ~10m)", untilExpiry)
	}
}

func TestGenerateCredentialsShortSessionExpiry(t *testing.T) {
	secret := "test-secret"
	token := "test-token"
	// Session expiry in 1 hour — credential should use the session expiry, not 24h.
	expiresAt := time.Now().Add(1 * time.Hour)

	creds := GenerateCredentials(secret, token, expiresAt, "turn.example.com")

	parts := strings.SplitN(creds.Username, ":", 2)
	var ts int64
	fmt.Sscanf(parts[0], "%d", &ts)

	credExpiry := time.Unix(ts, 0)
	untilExpiry := time.Until(credExpiry)

	if untilExpiry > 2*time.Hour {
		t.Fatalf("credential expiry should track short session expiry: %s", untilExpiry)
	}
}

func TestGenerateCredentialsNilOnEmptySecret(t *testing.T) {
	creds := GenerateCredentials("", "token", time.Now().Add(time.Hour), "turn.example.com")
	if creds != nil {
		t.Fatal("expected nil credentials for empty secret")
	}
}

func TestGenerateCredentialsVeryShortExpiry(t *testing.T) {
	secret := "test-secret"
	token := "test-token"
	// Session expiry in 30 seconds — much shorter than the 10m cap.
	expiresAt := time.Now().Add(30 * time.Second)

	creds := GenerateCredentials(secret, token, expiresAt, "turn.example.com")

	parts := strings.SplitN(creds.Username, ":", 2)
	if len(parts) != 2 {
		t.Fatalf("bad username format: %q", creds.Username)
	}
	var ts int64
	fmt.Sscanf(parts[0], "%d", &ts)

	credExpiry := time.Unix(ts, 0)
	untilExpiry := time.Until(credExpiry)

	// Should be ~30s, not 10m.
	if untilExpiry > 2*time.Minute {
		t.Fatalf("credential expiry too far out: %s (expected ~30s)", untilExpiry)
	}
}

func TestGenerateCredentialsExpiryAlreadyPassed(t *testing.T) {
	secret := "test-secret"
	token := "test-token"
	// Session expiry in the past — credential should still be generated.
	expiresAt := time.Now().Add(-1 * time.Hour)

	creds := GenerateCredentials(secret, token, expiresAt, "turn.example.com")
	if creds == nil {
		t.Fatal("expected credentials even with expired session")
	}

	parts := strings.SplitN(creds.Username, ":", 2)
	if len(parts) != 2 {
		t.Fatalf("bad username format: %q", creds.Username)
	}
	var ts int64
	fmt.Sscanf(parts[0], "%d", &ts)

	credExpiry := time.Unix(ts, 0)
	// Should have used the session expiry (in the past).
	if credExpiry.After(time.Now()) {
		t.Fatalf("credential expiry should be in the past for expired session, got: %v", credExpiry)
	}
}
