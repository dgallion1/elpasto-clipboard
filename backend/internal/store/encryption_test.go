package store

import (
	"encoding/json"
	"testing"
)

func TestParseEncryptionMeta_Valid(t *testing.T) {
	input := `{"v":1,"kdf":"PBKDF2-SHA256","iterations":210000,"salt":"abc123","iv":"def456","payload":"text"}`
	meta, err := ParseEncryptionMeta(input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if meta.V != 1 || meta.KDF != "PBKDF2-SHA256" || meta.Iterations != 210000 {
		t.Errorf("unexpected meta: %+v", meta)
	}
	if meta.Salt != "abc123" || meta.IV != "def456" || meta.Payload != "text" {
		t.Errorf("unexpected meta fields: %+v", meta)
	}
}

func TestParseEncryptionMeta_Nil(t *testing.T) {
	meta, err := ParseEncryptionMeta(nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if meta != nil {
		t.Errorf("expected nil, got %+v", meta)
	}
}

func TestParseEncryptionMeta_InvalidJSON(t *testing.T) {
	_, err := ParseEncryptionMeta("not json")
	if err == nil {
		t.Error("expected error for invalid JSON")
	}
}

func TestParseEncryptionMeta_WrongVersion(t *testing.T) {
	input := `{"v":2,"kdf":"PBKDF2-SHA256","iterations":210000,"salt":"abc","iv":"def","payload":"text"}`
	_, err := ParseEncryptionMeta(input)
	if err == nil {
		t.Error("expected error for wrong version")
	}
}

func TestParseEncryptionMeta_WrongKDF(t *testing.T) {
	input := `{"v":1,"kdf":"scrypt","iterations":210000,"salt":"abc","iv":"def","payload":"text"}`
	_, err := ParseEncryptionMeta(input)
	if err == nil {
		t.Error("expected error for wrong KDF")
	}
}

func TestParseEncryptionMeta_ZeroIterations(t *testing.T) {
	input := `{"v":1,"kdf":"PBKDF2-SHA256","iterations":0,"salt":"abc","iv":"def","payload":"text"}`
	_, err := ParseEncryptionMeta(input)
	if err == nil {
		t.Error("expected error for zero iterations")
	}
}

func TestParseEncryptionMeta_NegativeIterations(t *testing.T) {
	input := `{"v":1,"kdf":"PBKDF2-SHA256","iterations":-1,"salt":"abc","iv":"def","payload":"text"}`
	_, err := ParseEncryptionMeta(input)
	if err == nil {
		t.Error("expected error for negative iterations")
	}
}

func TestParseEncryptionMeta_ExcessiveIterations(t *testing.T) {
	input := `{"v":1,"kdf":"PBKDF2-SHA256","iterations":999999999,"salt":"abc","iv":"def","payload":"text"}`
	_, err := ParseEncryptionMeta(input)
	if err == nil {
		t.Error("expected error for excessive iterations")
	}
}

func TestParseEncryptionMeta_MaxIterations(t *testing.T) {
	input := `{"v":1,"kdf":"PBKDF2-SHA256","iterations":1000000,"salt":"abc","iv":"def","payload":"text"}`
	meta, err := ParseEncryptionMeta(input)
	if err != nil {
		t.Fatalf("unexpected error for max iterations: %v", err)
	}
	if meta.Iterations != 1000000 {
		t.Errorf("iterations = %d, want 1000000", meta.Iterations)
	}
}

func TestParseEncryptionMeta_InvalidSalt(t *testing.T) {
	input := `{"v":1,"kdf":"PBKDF2-SHA256","iterations":210000,"salt":"abc/def","iv":"ghi","payload":"text"}`
	_, err := ParseEncryptionMeta(input)
	if err == nil {
		t.Error("expected error for invalid salt characters")
	}
}

func TestParseEncryptionMeta_EmptySalt(t *testing.T) {
	input := `{"v":1,"kdf":"PBKDF2-SHA256","iterations":210000,"salt":"","iv":"def","payload":"text"}`
	_, err := ParseEncryptionMeta(input)
	if err == nil {
		t.Error("expected error for empty salt")
	}
}

func TestParseEncryptionMeta_InvalidPayload(t *testing.T) {
	input := `{"v":1,"kdf":"PBKDF2-SHA256","iterations":210000,"salt":"abc","iv":"def","payload":"video"}`
	_, err := ParseEncryptionMeta(input)
	if err == nil {
		t.Error("expected error for invalid payload type")
	}
}

func TestParseEncryptionMeta_AllPayloadTypes(t *testing.T) {
	for _, payload := range []string{"text", "html", "binary"} {
		t.Run(payload, func(t *testing.T) {
			input := `{"v":1,"kdf":"PBKDF2-SHA256","iterations":210000,"salt":"abc","iv":"def","payload":"` + payload + `"}`
			meta, err := ParseEncryptionMeta(input)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if meta.Payload != payload {
				t.Errorf("payload = %q, want %q", meta.Payload, payload)
			}
		})
	}
}

func TestParseEncryptionMeta_ByteSlice(t *testing.T) {
	input := []byte(`{"v":1,"kdf":"PBKDF2-SHA256","iterations":210000,"salt":"abc","iv":"def","payload":"text"}`)
	meta, err := ParseEncryptionMeta(input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if meta.V != 1 {
		t.Errorf("V = %d, want 1", meta.V)
	}
}

func TestParseEncryptionMeta_RawMessage(t *testing.T) {
	input := json.RawMessage(`{"v":1,"kdf":"PBKDF2-SHA256","iterations":210000,"salt":"abc","iv":"def","payload":"text"}`)
	meta, err := ParseEncryptionMeta(input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if meta.V != 1 {
		t.Errorf("V = %d, want 1", meta.V)
	}
}

func TestParseEncryptionMeta_MapInput(t *testing.T) {
	input := map[string]any{
		"v": 1, "kdf": "PBKDF2-SHA256", "iterations": 210000,
		"salt": "abc", "iv": "def", "payload": "text",
	}
	meta, err := ParseEncryptionMeta(input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if meta.V != 1 || meta.Salt != "abc" {
		t.Errorf("unexpected meta: %+v", meta)
	}
}

func TestValid_NilReceiver(t *testing.T) {
	var m *ClipEncryptionMeta
	if m.Valid() {
		t.Error("nil receiver should not be valid")
	}
}

func TestValid_InvalidIV(t *testing.T) {
	m := &ClipEncryptionMeta{
		V: 1, KDF: EncryptionKDF, Iterations: 210000,
		Salt: "abc", IV: "invalid/chars", Payload: PayloadText,
	}
	if m.Valid() {
		t.Error("invalid IV chars should not be valid")
	}
}

func TestValid_EmptyIV(t *testing.T) {
	m := &ClipEncryptionMeta{
		V: 1, KDF: EncryptionKDF, Iterations: 210000,
		Salt: "abc", IV: "", Payload: PayloadText,
	}
	if m.Valid() {
		t.Error("empty IV should not be valid")
	}
}

func TestParseEncryptionMeta_ValidV2(t *testing.T) {
	input := `{"v":2,"kdf":"HKDF-SHA256","salt":"abc123","iv":"def456","payload":"text"}`
	meta, err := ParseEncryptionMeta(input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if meta.V != 2 {
		t.Errorf("V = %d, want 2", meta.V)
	}
	if meta.KDF != "HKDF-SHA256" {
		t.Errorf("KDF = %q, want 'HKDF-SHA256'", meta.KDF)
	}
	if meta.Iterations != 0 {
		t.Errorf("Iterations = %d, want 0", meta.Iterations)
	}
}

func TestParseEncryptionMeta_V2AllPayloadTypes(t *testing.T) {
	for _, payload := range []string{"text", "html", "binary"} {
		t.Run(payload, func(t *testing.T) {
			input := `{"v":2,"kdf":"HKDF-SHA256","salt":"abc","iv":"def","payload":"` + payload + `"}`
			meta, err := ParseEncryptionMeta(input)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if meta.V != 2 {
				t.Errorf("V = %d, want 2", meta.V)
			}
			if meta.Payload != payload {
				t.Errorf("payload = %q, want %q", meta.Payload, payload)
			}
		})
	}
}

func TestParseEncryptionMeta_V2WithIterationsRejected(t *testing.T) {
	input := `{"v":2,"kdf":"HKDF-SHA256","iterations":210000,"salt":"abc","iv":"def","payload":"text"}`
	_, err := ParseEncryptionMeta(input)
	if err == nil {
		t.Error("expected error for v2 with iterations")
	}
}

func TestParseEncryptionMeta_V2WrongKDF(t *testing.T) {
	input := `{"v":2,"kdf":"PBKDF2-SHA256","salt":"abc","iv":"def","payload":"text"}`
	_, err := ParseEncryptionMeta(input)
	if err == nil {
		t.Error("expected error for v2 with PBKDF2-SHA256 KDF")
	}
}

func TestParseEncryptionMeta_V1StillRequiresIterations(t *testing.T) {
	input := `{"v":1,"kdf":"PBKDF2-SHA256","iterations":0,"salt":"abc","iv":"def","payload":"text"}`
	_, err := ParseEncryptionMeta(input)
	if err == nil {
		t.Error("expected error for v1 without iterations")
	}
}

func TestParseEncryptionMeta_UnsupportedVersion(t *testing.T) {
	input := `{"v":99,"kdf":"PBKDF2-SHA256","iterations":210000,"salt":"abc","iv":"def","payload":"text"}`
	_, err := ParseEncryptionMeta(input)
	if err == nil {
		t.Error("expected error for unsupported version")
	}
}

func TestValid_EmptyPayload(t *testing.T) {
	m := &ClipEncryptionMeta{
		V: 1, KDF: EncryptionKDF, Iterations: 210000,
		Salt: "abc", IV: "def", Payload: "",
	}
	if m.Valid() {
		t.Error("empty payload should not be valid")
	}
}

func TestValid_EmptySalt(t *testing.T) {
	m := &ClipEncryptionMeta{
		V: 1, KDF: EncryptionKDF, Iterations: 210000,
		Salt: "", IV: "def", Payload: PayloadText,
	}
	if m.Valid() {
		t.Error("empty salt should not be valid")
	}
}

func TestValid_V1WrongKDF(t *testing.T) {
	m := &ClipEncryptionMeta{
		V: 1, KDF: "HKDF-SHA256", Iterations: 210000,
		Salt: "abc", IV: "def", Payload: PayloadText,
	}
	if m.Valid() {
		t.Error("v1 with HKDF-SHA256 should not be valid")
	}
}

func TestValid_V2WrongKDF(t *testing.T) {
	m := &ClipEncryptionMeta{
		V: 2, KDF: EncryptionKDF, Iterations: 0,
		Salt: "abc", IV: "def", Payload: PayloadText,
	}
	if m.Valid() {
		t.Error("v2 with PBKDF2-SHA256 should not be valid")
	}
}

func TestValid_V2WithIterations(t *testing.T) {
	m := &ClipEncryptionMeta{
		V: 2, KDF: EncryptionKDFV2, Iterations: 100,
		Salt: "abc", IV: "def", Payload: PayloadText,
	}
	if m.Valid() {
		t.Error("v2 with iterations should not be valid")
	}
}

func TestParseEncryptionMeta_UnmarshalableType(t *testing.T) {
	// A type that json.Marshal can handle but produces valid encryption meta.
	type customType struct {
		V          int    `json:"v"`
		KDF        string `json:"kdf"`
		Iterations int    `json:"iterations"`
		Salt       string `json:"salt"`
		IV         string `json:"iv"`
		Payload    string `json:"payload"`
	}
	input := customType{
		V: 1, KDF: "PBKDF2-SHA256", Iterations: 210000,
		Salt: "abc", IV: "def", Payload: "text",
	}
	meta, err := ParseEncryptionMeta(input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if meta.V != 1 {
		t.Errorf("V = %d, want 1", meta.V)
	}
}
