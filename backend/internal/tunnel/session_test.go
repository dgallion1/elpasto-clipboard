package tunnel

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFetchTurnCredentials(t *testing.T) {
	t.Run("parses credentials from session response", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			json.NewEncoder(w).Encode(map[string]any{
				"token":     "test-token",
				"expiresAt": "2026-03-15T12:00:00Z",
				"clips":     map[string]any{"A": []any{}, "B": []any{}},
				"turnCredentials": map[string]any{
					"urls":       []string{"turn:turn.example:3478?transport=udp"},
					"username":   "12345:test-token",
					"credential": "abc123",
				},
			})
		}))
		defer srv.Close()

		creds, err := FetchTurnCredentials(srv.URL, "test-token")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if creds == nil {
			t.Fatal("expected credentials, got nil")
		}
		if creds.URLs[0] != "turn:turn.example:3478?transport=udp" {
			t.Fatalf("unexpected URL: %s", creds.URLs[0])
		}
		if creds.Username != "12345:test-token" {
			t.Fatalf("unexpected username: %s", creds.Username)
		}
	})

	t.Run("returns nil when no credentials in response", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			json.NewEncoder(w).Encode(map[string]any{
				"token": "test-token",
				"clips": map[string]any{"A": []any{}, "B": []any{}},
			})
		}))
		defer srv.Close()

		creds, err := FetchTurnCredentials(srv.URL, "test-token")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if creds != nil {
			t.Fatal("expected nil when no TURN credentials in response")
		}
	})

	t.Run("returns error on 404", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(404)
		}))
		defer srv.Close()

		_, err := FetchTurnCredentials(srv.URL, "test-token")
		if err == nil {
			t.Fatal("expected error on 404")
		}
	})

	t.Run("returns error on network failure", func(t *testing.T) {
		// Use a URL where nothing is listening.
		_, err := FetchTurnCredentials("http://127.0.0.1:1", "test-token")
		if err == nil {
			t.Fatal("expected error on network failure")
		}
	})

	t.Run("returns error on invalid JSON response", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(200)
			_, _ = w.Write([]byte("not json at all"))
		}))
		defer srv.Close()

		_, err := FetchTurnCredentials(srv.URL, "test-token")
		if err == nil {
			t.Fatal("expected error on invalid JSON")
		}
	})

	t.Run("returns error on 500 status", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(500)
		}))
		defer srv.Close()

		_, err := FetchTurnCredentials(srv.URL, "test-token")
		if err == nil {
			t.Fatal("expected error on 500")
		}
	})
}
