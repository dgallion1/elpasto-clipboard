package api

import "testing"

func TestRedactPath(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"/api/health", "/api/health"},
		{"/api/sessions/alpha-bravo-charlie-delta-echo", "/api/sessions/[REDACTED]"},
		{"/api/sessions/alpha-bravo-charlie-delta-echo/events", "/api/sessions/[REDACTED]/events"},
		{"/api/sessions/alpha-bravo-charlie-delta-echo/signal", "/api/sessions/[REDACTED]/signal"},
		{"/api/sessions/alpha-bravo-charlie-delta-echo/tunnels/abc/viewer", "/api/sessions/[REDACTED]/tunnels/abc/viewer"},
		{"/api/tunnel/550e8400-e29b-41d4-a716-446655440000/aBcDeFgHiJkLmNoPqRsT/index.html",
			"/api/tunnel/550e8400-e29b-41d4-a716-446655440000/[REDACTED]/index.html"},
		{"/api/tunnel/550e8400-e29b-41d4-a716-446655440000/tok123/", "/api/tunnel/550e8400-e29b-41d4-a716-446655440000/[REDACTED]/"},
		// Paths that should not be redacted.
		{"/api/stats", "/api/stats"},
		{"/api/downloads/elpasto-tunnel-linux-arm64", "/api/downloads/elpasto-tunnel-linux-arm64"},
		// Sensitive query parameters are scrubbed too (defensive: in case a
		// full request target with a query is ever logged).
		{"/api/stats?key=supersecretkey", "/api/stats?key=[REDACTED]"},
		{"/api/sessions/lookup?prefix=alpha-bravo-charlie", "/api/sessions/lookup?prefix=[REDACTED]"},
		{"/api/tunnel/x?session=tok&access_token=at", "/api/tunnel/x?session=[REDACTED]&access_token=[REDACTED]"},
	}
	for _, tt := range tests {
		got := redactPath(tt.input)
		if got != tt.want {
			t.Errorf("redactPath(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}
