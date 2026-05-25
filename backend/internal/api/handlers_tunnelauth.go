package api

import (
	"net/http"
	"time"
)

func (s *Server) handleTunnelAuthStart(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r, s.cfg.TrustProxyHeaders)
	result := s.limiter.Check("tunnel-auth-start:"+ip, s.cfg.RateLimitTunnelAuthStartsPerHour, time.Hour)
	if !result.Allowed {
		writeError(w, http.StatusTooManyRequests, "Rate limit exceeded")
		return
	}
	s.tunnelAuth.Start(w, r)
}

func (s *Server) handleTunnelAuthCallback(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r, s.cfg.TrustProxyHeaders)
	result := s.limiter.Check("tunnel-auth-callback:"+ip, s.cfg.RateLimitTunnelAuthCallbacksPerHour, time.Hour)
	if !result.Allowed {
		writeError(w, http.StatusTooManyRequests, "Rate limit exceeded")
		return
	}
	s.tunnelAuth.Callback(w, r)
}
