package tokens

import (
	"crypto/rand"
	"fmt"
	"math/big"
	"strings"
)

const (
	WordCount       = 5
	PrefixWordCount = 3
)

var wordSet = func() map[string]struct{} {
	set := make(map[string]struct{}, len(words))
	for _, word := range words {
		set[word] = struct{}{}
	}
	return set
}()

var tokenWords = words

func Generate() (string, error) {
	if len(tokenWords) == 0 {
		return "", fmt.Errorf("token word list is empty")
	}

	parts := make([]string, 0, WordCount)
	limit := big.NewInt(int64(len(tokenWords)))
	for i := 0; i < WordCount; i++ {
		index, err := rand.Int(rand.Reader, limit)
		if err != nil {
			return "", err
		}
		parts = append(parts, tokenWords[index.Int64()])
	}

	return strings.Join(parts, "-"), nil
}

func IsValid(token string) bool {
	return IsValidPrefix(token, WordCount)
}

func IsValidPrefix(prefix string, wordCount int) bool {
	parts := strings.Split(strings.TrimSpace(prefix), "-")
	if len(parts) != wordCount {
		return false
	}

	for _, part := range parts {
		if _, ok := wordSet[part]; !ok {
			return false
		}
	}

	return true
}
