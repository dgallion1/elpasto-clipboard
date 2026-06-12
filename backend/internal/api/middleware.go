package api

import (
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
)

// redactPath replaces bearer tokens and capability tokens in URL paths
// with "[REDACTED]" so they don't appear in application logs.
var (
	// /api/sessions/{5-word-token}/... → /api/sessions/[REDACTED]/...
	sessionTokenRe = regexp.MustCompile(`(/api/sessions/)[a-z]+-[a-z]+-[a-z]+-[a-z]+-[a-z]+`)
	// /api/tunnel/{peerId}/{accessToken}/... → /api/tunnel/{peerId}/[REDACTED]/...
	tunnelAccessTokenRe = regexp.MustCompile(`(/api/tunnel/[0-9a-f-]{36}/)[A-Za-z0-9_-]+`)
	// ?key=... / ?session=... / ?access_token=... / ?prefix=... query values.
	sensitiveQueryRe = regexp.MustCompile(`([?&](?:key|session|access_token|prefix)=)[^&\s]+`)
)

func redactPath(path string) string {
	path = sessionTokenRe.ReplaceAllString(path, "${1}[REDACTED]")
	path = tunnelAccessTokenRe.ReplaceAllString(path, "${1}[REDACTED]")
	path = sensitiveQueryRe.ReplaceAllString(path, "${1}[REDACTED]")
	return path
}

// isTunnelRequest reports whether a request targets the tunnel relay, which
// proxies arbitrary content and manages its own complete header policy.
func isTunnelRequest(r *http.Request) bool {
	if strings.HasPrefix(r.URL.Path, "/api/tunnel/") {
		return true
	}
	host := r.Host
	if i := strings.IndexByte(host, ':'); i >= 0 {
		host = host[:i]
	}
	return strings.HasPrefix(host, "tunnel.")
}

// securityHeadersMiddleware applies baseline security headers to API and error
// responses, which would otherwise ship without them (only the frontend handler
// set them). It skips the tunnel relay so it can't impose defaults — e.g.
// nosniff on a dev server's untyped assets — that would break relayed content;
// the relay and the embedded frontend each set their own complete policy.
func (s *Server) securityHeadersMiddleware(next http.Handler) http.Handler {
	prod := os.Getenv("NODE_ENV") == "production"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isTunnelRequest(r) {
			h := w.Header()
			h.Set("X-Content-Type-Options", "nosniff")
			h.Set("Referrer-Policy", "same-origin")
			if prod {
				h.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) statsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r, s.cfg.TrustProxyHeaders)
		s.stats.RecordRequest(ip, r.Method, redactPath(r.URL.Path))
		next.ServeHTTP(w, r)
	})
}

func (s *Server) corsMiddleware(next http.Handler) http.Handler {
	allowed := map[string]struct{}{}
	for _, origin := range strings.Split(os.Getenv("CORS_ALLOWED_ORIGINS"), ",") {
		origin = strings.TrimSpace(origin)
		if origin != "" {
			allowed[origin] = struct{}{}
		}
	}
	devMode := os.Getenv("NODE_ENV") != "production"
	if devMode {
		allowed["http://localhost:3000"] = struct{}{}
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}

		origin := r.Header.Get("Origin")
		headers := w.Header()
		if _, ok := allowed[origin]; ok {
			headers.Set("Access-Control-Allow-Origin", origin)
			headers.Set("Vary", "Origin")
		} else if devMode && strings.HasPrefix(origin, "http://localhost:") {
			headers.Set("Access-Control-Allow-Origin", origin)
			headers.Set("Vary", "Origin")
		}
		headers.Set("Access-Control-Allow-Headers", "Content-Type")
		headers.Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		headers.Set("Access-Control-Expose-Headers", "X-ElPasto-Encrypted")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func (s *Server) logMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		startedAt := time.Now()
		next.ServeHTTP(w, r)
		s.logger.Printf("%s %s (%s)", r.Method, redactPath(r.URL.Path), time.Since(startedAt))
	})
}

func (s *Server) recoverMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				s.logger.Printf("panic serving %s %s: %v", r.Method, redactPath(r.URL.Path), recovered)
				writeError(w, http.StatusInternalServerError, "Internal server error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}
