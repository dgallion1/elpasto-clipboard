package api

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"elpasto/backend/internal/store"
	"elpasto/backend/internal/tokens"
	"elpasto/backend/internal/turn"
)

const lookupDelay = 500 * time.Millisecond
const (
	maxCreateSessionBodyBytes = 4 << 10
	maxBatchSessionBodyBytes  = 32 << 10
)

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"status":    "ok",
		"timestamp": time.Now().UTC().Format(time.RFC3339Nano),
	})
}

func (s *Server) handleCreateSession(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r, s.cfg.TrustProxyHeaders)
	result := s.limiter.Check("create:"+ip, s.cfg.RateLimitCreatePerHour, time.Hour)
	if !result.Allowed {
		writeError(w, http.StatusTooManyRequests, "Rate limit exceeded")
		return
	}

	contentType := r.Header.Get("Content-Type")
	hasBody := r.ContentLength > 0
	if hasBody && !strings.Contains(contentType, "application/json") {
		writeError(w, http.StatusUnsupportedMediaType, "Unsupported content type")
		return
	}

	if hasBody && strings.Contains(contentType, "application/json") {
		var body any
		if err := decodeJSONBody(w, r, maxCreateSessionBodyBytes, &body); err != nil {
			writeError(w, http.StatusBadRequest, "Malformed JSON")
			return
		}
	}

	session, err := s.store.CreateSession()
	if err != nil {
		if errors.Is(err, store.ErrAtCapacity) {
			writeError(w, http.StatusServiceUnavailable, "Service at capacity, please try again later")
			return
		}
		s.logger.Printf("failed to create session: %v", err)
		writeError(w, http.StatusInternalServerError, "Internal server error")
		return
	}

	writeJSON(w, http.StatusCreated, map[string]string{
		"token":     session.Token,
		"expiresAt": session.ExpiresAt,
	})
	s.stats.RecordSessionCreated()
}

func (s *Server) handleGetSession(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	session := s.store.GetSessionByToken(token)
	if session == nil {
		writeError(w, http.StatusNotFound, "Not found")
		return
	}

	s.stats.RecordSessionView()
	resp := map[string]any{
		"token":     session.Token,
		"createdAt": session.CreatedAt,
		"expiresAt": session.ExpiresAt,
		"clips": map[string]any{
			"A": []any{},
			"B": []any{},
		},
	}
	expiresAt, _ := time.Parse(time.RFC3339, session.ExpiresAt)
	if creds := turn.GenerateCredentials(
		s.cfg.TurnSecret,
		session.Token,
		expiresAt,
		s.cfg.TurnServer,
	); creds != nil {
		resp["turnCredentials"] = creds
	}
	if s.tunnelRegistry != nil {
		if tunnels := s.tunnelRegistry.ListBySession(token); len(tunnels) > 0 {
			resp["tunnels"] = tunnels
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleLookupSession(w http.ResponseWriter, r *http.Request) {
	prefix := strings.TrimSpace(r.URL.Query().Get("prefix"))
	if !tokens.IsValidPrefix(prefix, tokens.PrefixWordCount) {
		writeError(w, http.StatusBadRequest, "Invalid prefix")
		return
	}

	ip := clientIP(r, s.cfg.TrustProxyHeaders)
	result := s.limiter.Check("lookup:"+ip, s.cfg.RateLimitLookupsPerMinute, time.Minute)
	if !result.Allowed {
		writeError(w, http.StatusTooManyRequests, "Rate limit exceeded")
		return
	}

	if !sleepWithContext(r.Context(), lookupDelay) {
		return
	}

	session := s.store.FindSessionByTokenPrefix(prefix)
	if session == nil {
		writeError(w, http.StatusNotFound, "Not found")
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"token": session.Token})
}

type batchCreateSessionsRequest struct {
	Tokens []string `json:"tokens"`
}

const maxBatchTokens = 20

func (s *Server) handleBatchCreateSessions(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.EnableBatchSessionCreate {
		writeError(w, http.StatusForbidden, "Batch session creation is disabled")
		return
	}

	ip := clientIP(r, s.cfg.TrustProxyHeaders)
	result := s.limiter.Check("batch-create:"+ip, s.cfg.RateLimitBatchCreatePerHour, time.Hour)
	if !result.Allowed {
		writeError(w, http.StatusTooManyRequests, "Rate limit exceeded")
		return
	}

	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		writeError(w, http.StatusBadRequest, "Content-Type must be application/json")
		return
	}

	var req batchCreateSessionsRequest
	if err := decodeJSONBody(w, r, maxBatchSessionBodyBytes, &req); err != nil {
		writeError(w, http.StatusBadRequest, "Malformed JSON")
		return
	}

	if len(req.Tokens) == 0 {
		writeError(w, http.StatusBadRequest, "tokens must be a non-empty array")
		return
	}

	if len(req.Tokens) > maxBatchTokens {
		writeError(w, http.StatusBadRequest, "tokens must contain at most 20 entries")
		return
	}

	// Normalize, de-duplicate (preserving order), and validate.
	seen := make(map[string]struct{}, len(req.Tokens))
	var validTokens []string
	var invalidTokens []string

	for _, raw := range req.Tokens {
		tok := strings.TrimSpace(raw)
		if _, dup := seen[tok]; dup {
			continue
		}
		seen[tok] = struct{}{}

		if !tokens.IsValid(tok) {
			invalidTokens = append(invalidTokens, tok)
		} else {
			validTokens = append(validTokens, tok)
		}
	}

	storeResult := s.store.CreateSessionsWithTokens(validTokens)

	for range storeResult.Created {
		s.stats.RecordSessionCreated()
	}

	created := storeResult.Created
	if created == nil {
		created = []string{}
	}
	existing := storeResult.Existing
	if existing == nil {
		existing = []string{}
	}
	capacity := storeResult.Capacity
	if capacity == nil {
		capacity = []string{}
	}
	if invalidTokens == nil {
		invalidTokens = []string{}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"created":  created,
		"existing": existing,
		"invalid":  invalidTokens,
		"capacity": capacity,
	})
}

func (s *Server) handleClaimTunnelViewer(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	if s.store.GetSessionByToken(token) == nil {
		writeError(w, http.StatusNotFound, "Not found")
		return
	}

	peerID := r.PathValue("peerId")
	if s.tunnelRegistry == nil {
		writeError(w, http.StatusNotFound, "Not found")
		return
	}

	prefix, ok := s.tunnelRegistry.PrefixForSessionPeer(token, peerID)
	if !ok {
		writeError(w, http.StatusNotFound, "Not found")
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"prefix": prefix})
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	if !s.statsKeyAuthorized(r) {
		writeError(w, http.StatusNotFound, "Not found")
		return
	}
	writeJSON(w, http.StatusOK, s.stats.Snapshot())
}
