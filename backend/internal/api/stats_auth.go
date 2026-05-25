package api

import (
	"crypto/subtle"
	"net/http"
	"strings"
)

// statsKeyAuthorized returns true when the configured STATS_DASHBOARD_KEY
// matches an Authorization: Bearer header or a `?key=` query param. When
// the env var is unset it returns false: the endpoint is treated as not
// configured. Callers should respond 404 to avoid leaking endpoint
// existence (matches the capability-URL pattern used elsewhere in elpasto).
func (s *Server) statsKeyAuthorized(r *http.Request) bool {
	expected := s.cfg.StatsDashboardKey
	if expected == "" {
		return false
	}

	if header := r.Header.Get("Authorization"); strings.HasPrefix(header, "Bearer ") {
		got := strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
		if subtle.ConstantTimeCompare([]byte(got), []byte(expected)) == 1 {
			return true
		}
	}

	if got := r.URL.Query().Get("key"); got != "" {
		if subtle.ConstantTimeCompare([]byte(got), []byte(expected)) == 1 {
			return true
		}
	}

	return false
}
