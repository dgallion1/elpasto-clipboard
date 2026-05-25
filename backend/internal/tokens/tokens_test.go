package tokens

import (
	"crypto/rand"
	"errors"
	"strings"
	"testing"
)

func TestGenerate(t *testing.T) {
	oldTokenWords := tokenWords
	t.Cleanup(func() {
		tokenWords = oldTokenWords
	})

	tokenWords = words
	token, err := Generate()
	if err != nil {
		t.Fatalf("Generate returned error: %v", err)
	}

	parts := strings.Split(token, "-")
	if len(parts) != WordCount {
		t.Fatalf("expected %d parts, got %d", WordCount, len(parts))
	}
	for _, part := range parts {
		if _, ok := wordSet[part]; !ok {
			t.Fatalf("unexpected token word %q", part)
		}
	}
}

func TestGenerateWithEmptyWordList(t *testing.T) {
	oldTokenWords := tokenWords
	t.Cleanup(func() {
		tokenWords = oldTokenWords
	})

	tokenWords = nil
	if _, err := Generate(); err == nil {
		t.Fatal("expected Generate to fail with empty word list")
	}
}

func TestGenerateWithSingleWordList(t *testing.T) {
	oldTokenWords := tokenWords
	t.Cleanup(func() {
		tokenWords = oldTokenWords
	})

	// Single-word list — token will be "alpha-alpha-alpha-alpha-alpha".
	tokenWords = []string{"alpha"}
	token, err := Generate()
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if token != "alpha-alpha-alpha-alpha-alpha" {
		t.Fatalf("unexpected token: %q", token)
	}
}

func TestIsValid(t *testing.T) {
	tests := []struct {
		token string
		want  bool
	}{
		{"amber-anchor-apple-arch-arrow", true},
		{"amber-anchor-apple-arch", false},            // 4 words
		{"amber-anchor-apple-arch-arrow-extra", false}, // 6 words
		{"notaword-anchor-apple-arch-arrow", false},    // invalid word
		{"", false},
		{"amber", false}, // 1 word
	}
	for _, tt := range tests {
		t.Run(tt.token, func(t *testing.T) {
			if got := IsValid(tt.token); got != tt.want {
				t.Fatalf("IsValid(%q) = %v, want %v", tt.token, got, tt.want)
			}
		})
	}
}

func TestIsValidPrefix(t *testing.T) {
	tests := []struct {
		prefix    string
		wordCount int
		want      bool
	}{
		{"amber-anchor-apple", 3, true},
		{"amber-anchor", 3, false},              // 2 words, need 3
		{"notaword-anchor-apple", 3, false},     // invalid word
		{"amber-anchor-apple-arch-arrow", 5, true},
		{"  amber-anchor-apple  ", 3, true},     // trimmed whitespace
	}
	for _, tt := range tests {
		t.Run(tt.prefix, func(t *testing.T) {
			if got := IsValidPrefix(tt.prefix, tt.wordCount); got != tt.want {
				t.Fatalf("IsValidPrefix(%q, %d) = %v, want %v", tt.prefix, tt.wordCount, got, tt.want)
			}
		})
	}
}

func TestGenerateUniqueness(t *testing.T) {
	seen := make(map[string]bool)
	for i := 0; i < 20; i++ {
		token, err := Generate()
		if err != nil {
			t.Fatalf("Generate: %v", err)
		}
		if seen[token] {
			t.Fatalf("duplicate token generated: %s", token)
		}
		seen[token] = true
	}
}

// failReader is an io.Reader that always returns an error.
type failReader struct{}

func (failReader) Read([]byte) (int, error) {
	return 0, errors.New("forced rand failure")
}

func TestGenerateRandFailure(t *testing.T) {
	original := rand.Reader
	t.Cleanup(func() { rand.Reader = original })

	rand.Reader = failReader{}
	_, err := Generate()
	if err == nil {
		t.Fatal("expected Generate to fail when rand.Reader errors")
	}
	if !strings.Contains(err.Error(), "forced rand failure") {
		t.Fatalf("unexpected error: %v", err)
	}
}
