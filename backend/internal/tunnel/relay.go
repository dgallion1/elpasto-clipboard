package tunnel

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
)

const (
	maxTunnelWSPerIP      = 10
	maxRequestBodySize    = 10 << 20 // 10 MB
	responseHeaderTimeout = 60 * time.Second
	wsPingInterval        = 30 * time.Second
)

// TunnelEventPublisher publishes SSE events to session subscribers.
type TunnelEventPublisher interface {
	Publish(token, eventName string, data any)
}

// SessionValidator checks if a session token is valid.
type SessionValidator func(token string) bool

// TunnelAuthValidator validates a tunnel auth token and returns claims.
// Returns nil claims and an error if the token is invalid.
type TunnelAuthValidator func(raw string) error

// RelayHandler handles the two tunnel relay endpoints:
//   - GET /api/tunnel/ws?session=TOKEN&peer=PEERID  (WebSocket from CLI)
//   - ANY /api/tunnel/{peerId}/{accessToken}/{path...} (HTTP proxy from browser)
type RelayHandler struct {
	registry      *TunnelRegistry
	publisher     TunnelEventPublisher
	validate      SessionValidator
	authValidator TunnelAuthValidator // nil means auth disabled
	clientIP      func(*http.Request) string
	logger        *log.Logger
	mux           *http.ServeMux
	tunnelWSConns sync.Map // IP -> *atomic.Int32
}

// NewRelayHandler creates a RelayHandler and registers its routes on its own mux.
// If authValidator is non-nil, tunnel WebSocket registration requires a valid tunnel auth token.
func NewRelayHandler(registry *TunnelRegistry, publisher TunnelEventPublisher, validate SessionValidator, clientIP func(*http.Request) string, logger *log.Logger, authValidator TunnelAuthValidator) *RelayHandler {
	h := &RelayHandler{
		registry:      registry,
		publisher:     publisher,
		validate:      validate,
		authValidator: authValidator,
		clientIP:      clientIP,
		logger:        logger,
		mux:           http.NewServeMux(),
	}
	if h.clientIP == nil {
		h.clientIP = func(r *http.Request) string {
			host := r.RemoteAddr
			if idx := strings.LastIndex(host, ":"); idx >= 0 {
				return host[:idx]
			}
			return host
		}
	}
	h.mux.HandleFunc("GET /api/tunnel/ws", h.handleTunnelWS)
	h.mux.HandleFunc("/api/tunnel/{peerId}/{accessToken}/{path...}", h.handleTunnelProxy)
	return h
}

// ServeHTTP implements http.Handler.
func (h *RelayHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.mux.ServeHTTP(w, r)
}

// tunnelWSConnCount returns (or creates) the atomic counter for the given IP.
func (h *RelayHandler) tunnelWSConnCount(ip string) *atomic.Int32 {
	val, _ := h.tunnelWSConns.LoadOrStore(ip, &atomic.Int32{})
	return val.(*atomic.Int32)
}

func (h *RelayHandler) releaseTunnelWSConnCount(ip string, counter *atomic.Int32) {
	if counter.Add(-1) == 0 {
		h.tunnelWSConns.CompareAndDelete(ip, counter)
	}
}

func relayWriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func relayWriteError(w http.ResponseWriter, status int, message string) {
	relayWriteJSON(w, status, map[string]string{"error": message})
}

// handleTunnelWS handles GET /api/tunnel/ws?session=TOKEN&peer=PEERID
func (h *RelayHandler) handleTunnelWS(w http.ResponseWriter, r *http.Request) {
	// Tunnel auth check — if enabled, require Authorization: Bearer ept_...
	if h.authValidator != nil {
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			relayWriteError(w, http.StatusUnauthorized, "Tunnel authentication required")
			return
		}
		bearerToken := strings.TrimPrefix(authHeader, "Bearer ")
		if bearerToken == authHeader {
			relayWriteError(w, http.StatusUnauthorized, "Invalid authorization format")
			return
		}
		if err := h.authValidator(bearerToken); err != nil {
			relayWriteError(w, http.StatusUnauthorized, "Invalid tunnel auth token")
			return
		}
	}

	token := r.URL.Query().Get("session")
	peerID := r.URL.Query().Get("peer")

	if token == "" || !h.validate(token) {
		relayWriteError(w, http.StatusNotFound, "Session not found")
		return
	}

	if _, err := uuid.Parse(peerID); err != nil {
		relayWriteError(w, http.StatusBadRequest, "Invalid peer ID: must be a UUID")
		return
	}

	ip := h.clientIP(r)
	counter := h.tunnelWSConnCount(ip)
	if counter.Load() >= maxTunnelWSPerIP {
		relayWriteError(w, http.StatusTooManyRequests, "Too many tunnel WebSocket connections")
		return
	}
	counter.Add(1)
	defer h.releaseTunnelWSConnCount(ip, counter)

	clientToken := r.URL.Query().Get("access_token")
	tc, err := h.registry.Register(peerID, token, clientToken)
	if err != nil {
		relayWriteError(w, http.StatusConflict, "Could not register tunnel: "+err.Error())
		return
	}
	h.registry.SetIP(peerID, ip)

	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		// Accept already wrote the error response
		h.registry.Unregister(peerID)
		return
	}
	tc.WS = conn
	conn.SetReadLimit(1 << 20) // 1 MB — CLI sends ~44 KB base64 response body chunks

	defer func() {
		h.registry.Unregister(peerID)
		conn.Close(websocket.StatusNormalClosure, "tunnel closed")
		h.publisher.Publish(token, "tunnel:close", map[string]any{
			"peerId": peerID,
			"type":   "tunnel:close",
		})
	}()

	// Send tunnel:config with the assigned prefix.
	cfgMsg := ConfigMsg{
		Type:   MsgConfig,
		Prefix: tc.Prefix,
	}
	cfgBytes, _ := Encode(cfgMsg)
	if err := conn.Write(r.Context(), websocket.MessageText, cfgBytes); err != nil {
		return
	}

	// Ping loop — keeps the connection alive through Cloudflare Tunnel.
	// On failure, closes the WebSocket to immediately trigger CLI reconnect
	// rather than waiting for Cloudflare's idle timeout.
	pingCtx, pingCancel := context.WithCancel(r.Context())
	defer pingCancel()
	go func() {
		ticker := time.NewTicker(wsPingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-pingCtx.Done():
				return
			case <-ticker.C:
				pingTimeout, cancel := context.WithTimeout(pingCtx, 10*time.Second)
				err := conn.Ping(pingTimeout)
				cancel()
				if err != nil {
					conn.Close(websocket.StatusGoingAway, "ping failed")
					return
				}
			}
		}
	}()

	// Read loop.
	for {
		_, raw, err := conn.Read(r.Context())
		if err != nil {
			return
		}

		msgType, err := DecodeType(raw)
		if err != nil {
			continue
		}

		switch msgType {
		case MsgAnnounce:
			var msg AnnounceMsg
			if err := json.Unmarshal(raw, &msg); err != nil {
				continue
			}
			// Store announce metadata on the TunnelConn for later ListBySession.
			tc.Label = msg.Label
			tc.Port = msg.Port
			// Enrich with server-assigned fields.
			enriched := map[string]any{
				"type":        string(MsgAnnounce),
				"peerId":      peerID,
				"serverRelay": true,
			}
			if msg.Label != "" {
				enriched["label"] = msg.Label
			}
			if msg.Port != 0 {
				enriched["port"] = msg.Port
			}
			h.publisher.Publish(token, "tunnel:announce", enriched)

		case MsgClose:
			h.publisher.Publish(token, "tunnel:close", map[string]any{
				"peerId": peerID,
				"type":   "tunnel:close",
			})
			return

		case MsgResponse, MsgResponseBody, MsgResponseEnd, MsgError:
			// Extract requestId to dispatch to the waiting proxy goroutine.
			var env struct {
				RequestID string `json:"requestId"`
			}
			if err := json.Unmarshal(raw, &env); err != nil {
				continue
			}
			if env.RequestID != "" {
				tc.DispatchResponse(env.RequestID, json.RawMessage(raw))
				if msgType == MsgResponseEnd || msgType == MsgError {
					tc.CompleteRequest(env.RequestID)
				}
			}
		}
	}
}

// handleTunnelProxy handles ANY /api/tunnel/{peerId}/{accessToken}/{path...}
func (h *RelayHandler) handleTunnelProxy(w http.ResponseWriter, r *http.Request) {
	peerID := r.PathValue("peerId")
	accessToken := r.PathValue("accessToken")
	path := r.PathValue("path")

	if _, err := uuid.Parse(peerID); err != nil {
		relayWriteError(w, http.StatusBadRequest, "Invalid peer ID")
		return
	}

	tc := h.registry.Get(peerID)
	if tc == nil {
		relayWriteError(w, http.StatusBadGateway, "Tunnel not connected")
		return
	}
	if tc.AccessToken != accessToken {
		relayWriteError(w, http.StatusNotFound, "Not found")
		return
	}

	// Reject if tunnel has exceeded its bandwidth allowance.
	if tc.BytesRelayed() >= MaxBytesPerTunnel {
		relayWriteError(w, http.StatusTooManyRequests, "Tunnel bandwidth limit exceeded")
		return
	}

	// Reject upgrade requests.
	if strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade") {
		relayWriteError(w, http.StatusBadRequest, "WebSocket upgrade not supported through relay")
		return
	}

	// Strip hop-by-hop and sensitive headers.
	hopByHop := []string{
		"connection", "upgrade", "transfer-encoding", "te", "trailer", "keep-alive",
		"cookie", "authorization", "proxy-authorization",
		"x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port",
		"forwarded", "cf-connecting-ip", "true-client-ip", "x-real-ip",
	}
	headers := make(map[string]string)
	for k, vv := range r.Header {
		lower := strings.ToLower(k)
		skip := false
		for _, h := range hopByHop {
			if lower == h {
				skip = true
				break
			}
		}
		if !skip && len(vv) > 0 {
			headers[k] = vv[0]
		}
	}

	// Build the tunnel request URL: preserve query string.
	reqURL := "/" + path
	if r.URL.RawQuery != "" {
		reqURL += "?" + r.URL.RawQuery
	}

	// Create request slot.
	reqID, respCh, err := tc.CreateRequest()
	if err != nil {
		relayWriteError(w, http.StatusServiceUnavailable, "Too many concurrent tunnel requests")
		return
	}

	// Read and encode request body (reject if over 10 MB).
	var bodyB64 string
	if r.Body != nil {
		limited := io.LimitReader(r.Body, maxRequestBodySize+1)
		bodyBytes, err := io.ReadAll(limited)
		if err != nil {
			tc.CompleteRequest(reqID)
			relayWriteError(w, http.StatusBadRequest, "Failed to read request body")
			return
		}
		if int64(len(bodyBytes)) > maxRequestBodySize {
			tc.CompleteRequest(reqID)
			relayWriteError(w, http.StatusRequestEntityTooLarge, "Request body too large")
			return
		}
		if len(bodyBytes) > 0 {
			bodyB64 = base64.StdEncoding.EncodeToString(bodyBytes)
		}
	}

	// Send tunnel:request to CLI.
	reqMsg, _ := Encode(RequestMsg{
		Type:      MsgRequest,
		RequestID: reqID,
		Method:    r.Method,
		URL:       reqURL,
		Headers:   headers,
	})
	ctx := r.Context()
	if err := tc.WS.Write(ctx, websocket.MessageText, reqMsg); err != nil {
		tc.CompleteRequest(reqID)
		relayWriteError(w, http.StatusBadGateway, "Failed to send request to tunnel")
		return
	}

	// Send body if present.
	if bodyB64 != "" {
		bodyMsg, _ := Encode(RequestBodyMsg{
			Type:      MsgRequestBody,
			RequestID: reqID,
			Data:      bodyB64,
		})
		if err := tc.WS.Write(ctx, websocket.MessageText, bodyMsg); err != nil {
			tc.CompleteRequest(reqID)
			relayWriteError(w, http.StatusBadGateway, "Failed to send request body to tunnel")
			return
		}
	}

	// Send tunnel:request-end.
	endMsg, _ := Encode(RequestEndMsg{
		Type:      MsgRequestEnd,
		RequestID: reqID,
	})
	if err := tc.WS.Write(ctx, websocket.MessageText, endMsg); err != nil {
		tc.CompleteRequest(reqID)
		relayWriteError(w, http.StatusBadGateway, "Failed to send request end to tunnel")
		return
	}

	// Wait for response header with a 60s timeout.
	headerTimer := time.NewTimer(responseHeaderTimeout)
	defer headerTimer.Stop()

	flusher, hasFlusher := w.(http.Flusher)

	headersSent := false

	for {
		var raw json.RawMessage
		select {
		case <-ctx.Done():
			if !headersSent {
				relayWriteError(w, http.StatusGatewayTimeout, "Request cancelled")
			}
			return
		case <-headerTimer.C:
			if !headersSent {
				relayWriteError(w, http.StatusGatewayTimeout, "Tunnel response timeout")
			}
			return
		case msg, ok := <-respCh:
			if !ok {
				// Channel closed — tunnel disconnected.
				if !headersSent {
					relayWriteError(w, http.StatusBadGateway, "Tunnel disconnected")
				}
				return
			}
			raw = msg
		}

		msgType, err := DecodeType(raw)
		if err != nil {
			continue
		}

		switch msgType {
		case MsgResponse:
			var resp ResponseMsg
			if err := json.Unmarshal(raw, &resp); err != nil {
				relayWriteError(w, http.StatusBadGateway, "Malformed response from tunnel")
				return
			}
			// Stop the header timeout — we got headers. Drain the channel
			// in case the timer fired between select and here.
			if !headerTimer.Stop() {
				select {
				case <-headerTimer.C:
				default:
				}
			}

			// Copy response headers, stripping hop-by-hop and Set-Cookie.
			for k, v := range resp.Headers {
				lower := strings.ToLower(k)
				if lower == "set-cookie" || lower == "transfer-encoding" || lower == "service-worker-allowed" {
					continue
				}
				w.Header().Set(k, v)
			}
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Referrer-Policy", "no-referrer")
			w.Header().Set("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-popups")
			w.WriteHeader(resp.Status)
			headersSent = true
			if hasFlusher {
				flusher.Flush()
			}

		case MsgResponseBody:
			var body ResponseBodyMsg
			if err := json.Unmarshal(raw, &body); err != nil {
				return
			}
			decoded, err := base64.StdEncoding.DecodeString(body.Data)
			if err != nil {
				return
			}
			tc.AddBytes(int64(len(decoded)))
			if _, err := w.Write(decoded); err != nil {
				return
			}
			if hasFlusher {
				flusher.Flush()
			}

		case MsgResponseEnd:
			return

		case MsgError:
			var errMsg ErrorMsg
			if err := json.Unmarshal(raw, &errMsg); err != nil {
				return
			}
			if !headersSent {
				relayWriteError(w, http.StatusBadGateway, "Tunnel error: "+errMsg.Message)
			}
			return
		}
	}
}
