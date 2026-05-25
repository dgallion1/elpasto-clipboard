package api

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const maxSSEPerIP = 10

// sseConns tracks per-IP SSE connection counts.
var sseConns sync.Map // map[string]*atomic.Int64

func sseConnCount(ip string) *atomic.Int64 {
	val, _ := sseConns.LoadOrStore(ip, &atomic.Int64{})
	return val.(*atomic.Int64)
}

func releaseSSEConnCount(ip string, counter *atomic.Int64) {
	if counter.Add(-1) == 0 {
		sseConns.CompareAndDelete(ip, counter)
	}
}

func (s *Server) handleSessionEvents(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	session := s.store.GetSessionByToken(token)
	if session == nil {
		writeError(w, http.StatusNotFound, "Not found")
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "Streaming unsupported")
		return
	}

	ip := clientIP(r, s.cfg.TrustProxyHeaders)
	counter := sseConnCount(ip)
	if counter.Load() >= maxSSEPerIP {
		writeError(w, http.StatusTooManyRequests, "Too many SSE connections")
		return
	}
	counter.Add(1)
	defer releaseSSEConnCount(ip, counter)

	expiresAt, err := time.Parse(time.RFC3339, session.ExpiresAt)
	if err != nil {
		s.logger.Printf("failed to parse session expiry %q: %v", session.ExpiresAt, err)
		writeError(w, http.StatusInternalServerError, "Internal server error")
		return
	}

	headers := w.Header()
	headers.Set("Content-Type", "text/event-stream")
	headers.Set("Cache-Control", "no-cache, no-store, must-revalidate")
	headers.Set("Connection", "keep-alive")
	headers.Set("X-Accel-Buffering", "no")

	subscription, unsubscribe := s.broker.Subscribe(token, ip)
	defer unsubscribe()

	_, _ = io.WriteString(w, ": connected\n\n")
	flusher.Flush()

	expiryTimer := time.NewTimer(time.Until(expiresAt))
	defer expiryTimer.Stop()

	keepaliveTicker := time.NewTicker(25 * time.Second)
	defer keepaliveTicker.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-expiryTimer.C:
			if err := writeSSEEvent(w, "session:expired", map[string]string{"token": token}); err != nil {
				return
			}
			flusher.Flush()
			return
		case <-keepaliveTicker.C:
			_, _ = io.WriteString(w, ": ping\n\n")
			flusher.Flush()
		case event, ok := <-subscription:
			if !ok {
				return
			}
			if err := writeSSEEvent(w, event.Name, event.Data); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (s *Server) handlePublishPeerSignal(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	session := s.store.GetSessionByToken(token)
	if session == nil {
		writeError(w, http.StatusNotFound, "Not found")
		return
	}

	ip := clientIP(r, s.cfg.TrustProxyHeaders)
	result := s.limiter.Check("signal:"+ip, s.cfg.RateLimitSignalsPerMinute, time.Minute)
	if !result.Allowed {
		writeError(w, http.StatusTooManyRequests, "Rate limit exceeded")
		return
	}

	var payload map[string]any
	r.Body = http.MaxBytesReader(w, r.Body, 256<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.UseNumber()
	if err := decoder.Decode(&payload); err != nil {
		writeError(w, http.StatusBadRequest, "Malformed JSON")
		return
	}

	fromPeerID, fromOK := payload["fromPeerId"].(string)
	signalType, signalOK := payload["signalType"].(string)
	if !fromOK || strings.TrimSpace(fromPeerID) == "" {
		writeError(w, http.StatusBadRequest, "fromPeerId is required")
		return
	}
	if !signalOK || strings.TrimSpace(signalType) == "" {
		writeError(w, http.StatusBadRequest, "signalType is required")
		return
	}

	if toPeerID, ok := payload["toPeerId"]; ok {
		toPeerString, valid := toPeerID.(string)
		if !valid || strings.TrimSpace(toPeerString) == "" {
			writeError(w, http.StatusBadRequest, "toPeerId must be a non-empty string")
			return
		}
		payload["toPeerId"] = strings.TrimSpace(toPeerString)
	}

	payload["fromPeerId"] = strings.TrimSpace(fromPeerID)
	payload["signalType"] = strings.TrimSpace(signalType)

	// A WebRTC SDP offer marks the start of a new peer-to-peer negotiation,
	// which is the closest server-visible proxy for "this peer wants to share
	// a clip" given that clip payloads themselves are exchanged over the
	// resulting data channel and never reach the server.
	if signalType == "description" {
		if desc, ok := payload["description"].(map[string]any); ok {
			if t, ok := desc["type"].(string); ok && t == "offer" {
				s.stats.RecordClipCreated()
			}
		}
	}

	s.broker.Publish(token, "peer:signal", payload)

	writeJSON(w, http.StatusAccepted, map[string]bool{"ok": true})
}
