package tunnel

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/coder/websocket"
	"github.com/google/uuid"
)

// TunnelRegistry manages active WebSocket tunnel connections.
type TunnelRegistry struct {
	mu            sync.RWMutex
	conns         map[string]*TunnelConn // peerId -> connection
	bySession     map[string]int         // session -> count
	totalConns    int
	maxPerSession int
	maxGlobal     int
	tunnelBaseURL string // when set, prefix uses this instead of /api/tunnel/
}

// TunnelConn represents one CLI tunnel connected via WebSocket.
type TunnelConn struct {
	PeerID      string
	IP          string
	Session     string
	AccessToken string
	Prefix      string
	Label       string          // set when CLI sends tunnel:announce
	Port        int             // set when CLI sends tunnel:announce
	WS          *websocket.Conn // set in handleTunnelWS after websocket.Accept, not during Register

	mu      sync.Mutex
	pending map[string]chan json.RawMessage // requestId -> response channel

	bytesRelayed atomic.Int64 // total bytes proxied through this tunnel
}

// NewRegistry creates a TunnelRegistry with per-session and global connection limits.
// tunnelBaseURL, when non-empty, is used as the prefix base for tunnel URLs
// (e.g. "https://tunnel.example.com/"). When empty, defaults to "/api/tunnel/".
func NewRegistry(maxPerSession, maxGlobal int, tunnelBaseURL string) *TunnelRegistry {
	return &TunnelRegistry{
		conns:         make(map[string]*TunnelConn),
		bySession:     make(map[string]int),
		maxPerSession: maxPerSession,
		maxGlobal:     maxGlobal,
		tunnelBaseURL: tunnelBaseURL,
	}
}

// Register registers a new tunnel connection for the given peerID and session.
// If clientToken is non-empty and valid base64url (24 bytes decoded), it is used
// as the access token — this allows the CLI to keep a stable URL across reconnects.
// Returns an error if the peerID is already registered or if limits are exceeded.
func (r *TunnelRegistry) Register(peerID, session, clientToken string) (*TunnelConn, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if _, exists := r.conns[peerID]; exists {
		return nil, fmt.Errorf("tunnel registry: peer %q already registered", peerID)
	}
	if r.bySession[session] >= r.maxPerSession {
		return nil, fmt.Errorf("tunnel registry: session %q at per-session limit (%d)", session, r.maxPerSession)
	}
	if r.totalConns >= r.maxGlobal {
		return nil, fmt.Errorf("tunnel registry: global connection limit (%d) reached", r.maxGlobal)
	}

	token := clientToken
	if !isValidAccessToken(token) {
		token = generateAccessToken()
	}

	prefix := "/api/tunnel/" + peerID + "/" + token + "/"
	if r.tunnelBaseURL != "" {
		prefix = strings.TrimRight(r.tunnelBaseURL, "/") + "/" + peerID + "/" + token + "/"
	}

	conn := &TunnelConn{
		PeerID:      peerID,
		Session:     session,
		AccessToken: token,
		Prefix:      prefix,
		pending:     make(map[string]chan json.RawMessage),
	}

	r.conns[peerID] = conn
	r.bySession[session]++
	r.totalConns++

	return conn, nil
}

// Unregister removes a connection by peerID and closes all its pending channels.
func (r *TunnelRegistry) Unregister(peerID string) {
	r.mu.Lock()
	conn, ok := r.conns[peerID]
	if !ok {
		r.mu.Unlock()
		return
	}
	delete(r.conns, peerID)
	r.bySession[conn.Session]--
	if r.bySession[conn.Session] == 0 {
		delete(r.bySession, conn.Session)
	}
	r.totalConns--
	r.mu.Unlock()

	conn.closeAllPending()
}

// Get returns the TunnelConn for the given peerID, or nil if not found.
func (r *TunnelRegistry) Get(peerID string) *TunnelConn {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.conns[peerID]
}

// SetIP records the client IP for a registered tunnel connection.
func (r *TunnelRegistry) SetIP(peerID, ip string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if conn := r.conns[peerID]; conn != nil {
		conn.IP = ip
	}
}

// TunnelSummary is the public view of an active tunnel for API responses.
type TunnelSummary struct {
	PeerID      string `json:"peerId"`
	ServerRelay bool   `json:"serverRelay"`
	Label       string `json:"label,omitempty"`
	Port        int    `json:"port,omitempty"`
}

// ListBySession returns summaries of all active tunnels for a session.
func (r *TunnelRegistry) ListBySession(session string) []TunnelSummary {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var result []TunnelSummary
	for _, tc := range r.conns {
		if tc.Session == session {
			result = append(result, TunnelSummary{
				PeerID:      tc.PeerID,
				ServerRelay: true,
				Label:       tc.Label,
				Port:        tc.Port,
			})
		}
	}
	return result
}

// ConnectionsBySession returns session token -> sorted unique tunnel IPs.
func (r *TunnelRegistry) ConnectionsBySession() map[string][]string {
	r.mu.RLock()
	defer r.mu.RUnlock()

	sessions := make(map[string]map[string]struct{})
	for _, conn := range r.conns {
		if conn.IP == "" {
			continue
		}
		if sessions[conn.Session] == nil {
			sessions[conn.Session] = make(map[string]struct{})
		}
		sessions[conn.Session][conn.IP] = struct{}{}
	}

	result := make(map[string][]string, len(sessions))
	for session, ips := range sessions {
		list := make([]string, 0, len(ips))
		for ip := range ips {
			list = append(list, ip)
		}
		sort.Strings(list)
		result[session] = list
	}

	return result
}

// TunnelCount returns the total number of active tunnel connections.
func (r *TunnelRegistry) TunnelCount() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.totalConns
}

// PrefixForSessionPeer returns the active viewer prefix for a tunnel peer in the
// specified session.
func (r *TunnelRegistry) PrefixForSessionPeer(session, peerID string) (string, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	tc := r.conns[peerID]
	if tc == nil || tc.Session != session {
		return "", false
	}

	return tc.Prefix, true
}

// Shutdown closes all connections and their pending channels.
func (r *TunnelRegistry) Shutdown() {
	r.mu.Lock()
	conns := make([]*TunnelConn, 0, len(r.conns))
	for _, conn := range r.conns {
		conns = append(conns, conn)
	}
	r.conns = make(map[string]*TunnelConn)
	r.bySession = make(map[string]int)
	r.totalConns = 0
	r.mu.Unlock()

	for _, conn := range conns {
		conn.closeAllPending()
	}
}

// MaxBytesPerTunnel is the maximum total bytes relayed through a single tunnel
// connection. Once exceeded, new proxy requests are rejected with 429.
// The limit resets when the CLI reconnects (new TunnelConn).
const MaxBytesPerTunnel int64 = 512 << 20 // 512 MB

// AddBytes records relayed bytes and returns true if still under the limit.
func (tc *TunnelConn) AddBytes(n int64) bool {
	return tc.bytesRelayed.Add(n) <= MaxBytesPerTunnel
}

// BytesRelayed returns the total bytes relayed through this tunnel.
func (tc *TunnelConn) BytesRelayed() int64 {
	return tc.bytesRelayed.Load()
}

// CreateRequest reserves a request slot, generates a UUID requestID, and returns
// the ID and a channel on which the response will be delivered.
// Returns an error if the connection is already at MaxConcurrentRequests.
func (tc *TunnelConn) CreateRequest() (string, <-chan json.RawMessage, error) {
	tc.mu.Lock()
	defer tc.mu.Unlock()

	if len(tc.pending) >= MaxConcurrentRequests {
		return "", nil, fmt.Errorf("tunnel conn: at max concurrent requests (%d)", MaxConcurrentRequests)
	}

	reqID := uuid.New().String()
	ch := make(chan json.RawMessage, 64)
	tc.pending[reqID] = ch

	return reqID, ch, nil
}

// DispatchResponse routes a response message to the waiting channel for requestID.
// If no channel exists for the requestID, the message is discarded.
func (tc *TunnelConn) DispatchResponse(requestID string, msg json.RawMessage) {
	tc.mu.Lock()
	ch, ok := tc.pending[requestID]
	tc.mu.Unlock()

	if ok {
		ch <- msg
	}
}

// CompleteRequest removes the request slot and closes its channel.
func (tc *TunnelConn) CompleteRequest(requestID string) {
	tc.mu.Lock()
	ch, ok := tc.pending[requestID]
	if ok {
		delete(tc.pending, requestID)
	}
	tc.mu.Unlock()

	if ok {
		close(ch)
	}
}

// closeAllPending closes all pending response channels.
func (tc *TunnelConn) closeAllPending() {
	tc.mu.Lock()
	pending := tc.pending
	tc.pending = make(map[string]chan json.RawMessage)
	tc.mu.Unlock()

	for _, ch := range pending {
		close(ch)
	}
}

// generateAccessToken generates a cryptographically random URL-safe access token.
// crypto/rand.Read is guaranteed to succeed (Go 1.24+); entropy failure is process-fatal.
func generateAccessToken() string {
	b := make([]byte, 24)
	rand.Read(b)
	return base64.URLEncoding.EncodeToString(b)
}

// isValidAccessToken checks if a token is valid base64url and decodes to exactly 24 bytes.
func isValidAccessToken(token string) bool {
	if token == "" {
		return false
	}
	b, err := base64.URLEncoding.DecodeString(token)
	if err != nil {
		return false
	}
	return len(b) == 24
}
