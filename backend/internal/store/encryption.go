package store

import (
	"encoding/json"
	"fmt"
	"regexp"
)

const (
	EncryptionVersion = 1
	EncryptionKDF     = "PBKDF2-SHA256"
	EncryptionVersionV2 = 2
	EncryptionKDFV2     = "HKDF-SHA256"
)

const (
	PayloadText   = "text"
	PayloadHTML   = "html"
	PayloadBinary = "binary"
)

var base64URLPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

type ClipEncryptionMeta struct {
	V          int    `json:"v"`
	KDF        string `json:"kdf"`
	Iterations int    `json:"iterations"`
	Salt       string `json:"salt"`
	IV         string `json:"iv"`
	Payload    string `json:"payload"`
}

func (m *ClipEncryptionMeta) Valid() bool {
	if m == nil {
		return false
	}

	// Common validation for all versions
	if !base64URLPattern.MatchString(m.Salt) || !base64URLPattern.MatchString(m.IV) {
		return false
	}

	switch m.Payload {
	case PayloadText, PayloadHTML, PayloadBinary:
		// valid payload type, continue
	default:
		return false
	}

	// Version-specific validation
	switch m.V {
	case EncryptionVersion: // v1: PBKDF2-SHA256 with iterations
		if m.KDF != EncryptionKDF {
			return false
		}
		if m.Iterations <= 0 || m.Iterations > 1_000_000 {
			return false
		}
		return true

	case EncryptionVersionV2: // v2: HKDF-SHA256 without iterations
		if m.KDF != EncryptionKDFV2 {
			return false
		}
		if m.Iterations != 0 {
			return false
		}
		return true

	default:
		return false
	}
}

func ParseEncryptionMeta(value any) (*ClipEncryptionMeta, error) {
	if value == nil {
		return nil, nil
	}

	var raw []byte
	switch typed := value.(type) {
	case string:
		raw = []byte(typed)
	case []byte:
		raw = typed
	case json.RawMessage:
		raw = typed
	default:
		encoded, err := json.Marshal(typed)
		if err != nil {
			return nil, err
		}
		raw = encoded
	}

	var meta ClipEncryptionMeta
	if err := json.Unmarshal(raw, &meta); err != nil {
		return nil, err
	}
	if !meta.Valid() {
		return nil, fmt.Errorf("invalid clip encryption meta")
	}

	return &meta, nil
}
