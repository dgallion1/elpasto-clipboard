package tunnelauth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

func TestMintValidateRoundTrip(t *testing.T) {
	secret := "test-secret-32bytes-long-enough!"
	claims := TokenClaims{Sub: "123", Email: "alice@example.com"}
	token, err := Mint(secret, claims, 24*time.Hour)
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	if !strings.HasPrefix(token, tokenPrefix) {
		t.Fatalf("token missing prefix: %s", token)
	}

	got, err := Validate(secret, token, time.Now())
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if got.Sub != "123" || got.Email != "alice@example.com" {
		t.Fatalf("claims mismatch: %+v", got)
	}
	if got.Exp == 0 {
		t.Fatal("exp not set")
	}
}

func TestValidateExpiredToken(t *testing.T) {
	secret := "test-secret"
	claims := TokenClaims{Sub: "123", Email: "alice@example.com"}
	token, err := Mint(secret, claims, -1*time.Hour) // already expired
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	_, err = Validate(secret, token, time.Now())
	if err == nil || !strings.Contains(err.Error(), "expired") {
		t.Fatalf("expected expired error, got: %v", err)
	}
}

func TestValidateTamperedSignature(t *testing.T) {
	secret := "test-secret"
	claims := TokenClaims{Sub: "123", Email: "alice@example.com"}
	token, err := Mint(secret, claims, 24*time.Hour)
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	// Tamper with the last character of the signature.
	tampered := token[:len(token)-1] + "X"
	_, err = Validate(secret, tampered, time.Now())
	if err == nil || !strings.Contains(err.Error(), "signature") {
		t.Fatalf("expected signature error, got: %v", err)
	}
}

func TestValidateWrongSecret(t *testing.T) {
	token, _ := Mint("secret-a", TokenClaims{Sub: "1", Email: "a@b.com"}, time.Hour)
	_, err := Validate("secret-b", token, time.Now())
	if err == nil || !strings.Contains(err.Error(), "signature") {
		t.Fatalf("expected signature error, got: %v", err)
	}
}

func TestValidateMalformedToken(t *testing.T) {
	cases := []struct {
		name  string
		token string
	}{
		{"no prefix", "eyJzdWIiOiIxIn0.abc"},
		{"no dot", "ept_eyJzdWIiOiIxIn0abc"},
		{"empty", ""},
		{"prefix only", "ept_"},
		{"prefix with dot only", "ept_."},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Validate("secret", tc.token, time.Now())
			if err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

func TestMintEmptySecret(t *testing.T) {
	_, err := Mint("", TokenClaims{Sub: "1"}, time.Hour)
	if err == nil || !strings.Contains(err.Error(), "empty secret") {
		t.Fatalf("expected empty secret error, got: %v", err)
	}
}

func TestValidateEmptySecret(t *testing.T) {
	_, err := Validate("", "ept_abc.def", time.Now())
	if err == nil || !strings.Contains(err.Error(), "empty secret") {
		t.Fatalf("expected empty secret error, got: %v", err)
	}
}

// craftToken creates a token with a properly signed payload string (which may not be valid base64).
func craftToken(secret, payloadB64 string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payloadB64))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return tokenPrefix + payloadB64 + "." + sig
}

func TestValidate_InvalidBase64Payload(t *testing.T) {
	// Payload passes HMAC check but is not valid base64url — triggers decode error.
	secret := "test-secret"
	// "!!!" is not valid base64url.
	token := craftToken(secret, "!!!")
	_, err := Validate(secret, token, time.Now())
	if err == nil || !strings.Contains(err.Error(), "decode payload") {
		t.Fatalf("expected decode payload error, got: %v", err)
	}
}

func TestValidate_InvalidJSONPayload(t *testing.T) {
	// Payload is valid base64 but decodes to invalid JSON — triggers unmarshal error.
	secret := "test-secret"
	payloadB64 := base64.RawURLEncoding.EncodeToString([]byte("not-json"))
	token := craftToken(secret, payloadB64)
	_, err := Validate(secret, token, time.Now())
	if err == nil || !strings.Contains(err.Error(), "unmarshal claims") {
		t.Fatalf("expected unmarshal claims error, got: %v", err)
	}
}
