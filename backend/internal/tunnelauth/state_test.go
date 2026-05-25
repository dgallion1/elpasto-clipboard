package tunnelauth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"testing"
)

func TestStateRoundTrip(t *testing.T) {
	secret := "state-secret"
	state, err := MintState(secret, 12345)
	if err != nil {
		t.Fatalf("MintState: %v", err)
	}
	port, err := ValidateState(secret, state)
	if err != nil {
		t.Fatalf("ValidateState: %v", err)
	}
	if port != 12345 {
		t.Fatalf("port = %d, want 12345", port)
	}
}

func TestStateBadMAC(t *testing.T) {
	state, _ := MintState("secret-a", 8080)
	_, err := ValidateState("secret-b", state)
	if err == nil || !strings.Contains(err.Error(), "signature") {
		t.Fatalf("expected signature error, got: %v", err)
	}
}

func TestStateTampered(t *testing.T) {
	state, _ := MintState("secret", 8080)
	// Replace port with a different one.
	parts := strings.SplitN(state, ":", 3)
	tampered := parts[0] + ":9999:" + parts[2]
	_, err := ValidateState("secret", tampered)
	if err == nil || !strings.Contains(err.Error(), "signature") {
		t.Fatalf("expected signature error, got: %v", err)
	}
}

func TestStateMalformed(t *testing.T) {
	cases := []string{"", "abc", "abc:def", "abc:notanumber:sig"}
	for _, s := range cases {
		_, err := ValidateState("secret", s)
		if err == nil {
			t.Fatalf("expected error for state %q", s)
		}
	}
}

func TestStateInvalidPort(t *testing.T) {
	_, err := MintState("secret", 0)
	if err == nil {
		t.Fatal("expected error for port 0")
	}
	_, err = MintState("secret", 70000)
	if err == nil {
		t.Fatal("expected error for port 70000")
	}
}

func TestStateEmptySecret(t *testing.T) {
	_, err := MintState("", 8080)
	if err == nil {
		t.Fatal("expected error for empty secret")
	}
	_, err = ValidateState("", "a:8080:b")
	if err == nil {
		t.Fatal("expected error for empty secret")
	}
}

// craftState creates a state with a properly signed nonce:port pair (port may be invalid).
func craftState(secret, nonceB64, portStr string) string {
	payload := nonceB64 + ":" + portStr
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return payload + ":" + sig
}

func TestValidateState_PortZeroAfterValidMAC(t *testing.T) {
	// Craft a state with port=0 that has a valid MAC — triggers "invalid port in state".
	secret := "test-secret"
	state := craftState(secret, "dGVzdG5vbmNl", "0")
	_, err := ValidateState(secret, state)
	if err == nil || !strings.Contains(err.Error(), "invalid port") {
		t.Fatalf("expected invalid port error, got: %v", err)
	}
}

func TestValidateState_PortOverflowAfterValidMAC(t *testing.T) {
	secret := "test-secret"
	state := craftState(secret, "dGVzdG5vbmNl", "99999")
	_, err := ValidateState(secret, state)
	if err == nil || !strings.Contains(err.Error(), "invalid port") {
		t.Fatalf("expected invalid port error, got: %v", err)
	}
}

func TestValidateState_PortNonNumericAfterValidMAC(t *testing.T) {
	secret := "test-secret"
	state := craftState(secret, "dGVzdG5vbmNl", "abc")
	_, err := ValidateState(secret, state)
	if err == nil || !strings.Contains(err.Error(), "invalid port") {
		t.Fatalf("expected invalid port error, got: %v", err)
	}
}

func TestValidateState_NegativePortAfterValidMAC(t *testing.T) {
	secret := "test-secret"
	state := craftState(secret, "dGVzdG5vbmNl", "-1")
	_, err := ValidateState(secret, state)
	if err == nil || !strings.Contains(err.Error(), "invalid port") {
		t.Fatalf("expected invalid port error, got: %v", err)
	}
}

func TestMintState_NegativePort(t *testing.T) {
	_, err := MintState("secret", -1)
	if err == nil || !strings.Contains(err.Error(), "invalid port") {
		t.Fatalf("expected invalid port error, got: %v", err)
	}
}

