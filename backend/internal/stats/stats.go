// backend/internal/stats/stats.go
package stats

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sync"
	"sync/atomic"
	"time"
)

// SessionCounter returns the current number of active sessions.
type SessionCounter interface {
	SessionCount() int
}

// ConnectionReporter provides live connection data from the broker and tunnel registry.
type ConnectionReporter interface {
	SSEStats() (totalConns int, activeSessions int)
	TunnelCount() int
}

// Collector tracks visitor and usage stats in memory.
type Collector struct {
	startTime       time.Time
	pageViews       atomic.Int64
	apiRequests     atomic.Int64
	uniqueTotal     atomic.Int64
	sessionsCreated atomic.Int64
	sessionViews    atomic.Int64
	clipsCreated    atomic.Int64

	seen         sync.Map // SHA-256(IP) → struct{}
	counter      SessionCounter
	connReporter ConnectionReporter
}

var (
	newTicker          = time.NewTicker
	dailyResetInterval = 24 * time.Hour
)

// Snapshot is a point-in-time read of all stats.
type Snapshot struct {
	UptimeSeconds       int64                         `json:"uptime_seconds"`
	PageViews           int64                         `json:"page_views"`
	APIRequests         int64                         `json:"api_requests"`
	UniqueVisitors      int64                         `json:"unique_visitors"`
	SessionsCreated     int64                         `json:"sessions_created"`
	SessionViews        int64                         `json:"session_views"`
	ClipsCreated        int64                         `json:"clips_created"`
	ActiveSessions      int `json:"active_sessions"`
	SSEConnections      int `json:"sse_connections"`
	ActiveTunnels       int `json:"active_tunnels"`
	SessionsWithViewers int `json:"sessions_with_viewers"`
}

// New creates a Collector. counter and connReporter may be nil.
func New(counter SessionCounter, connReporter ConnectionReporter) *Collector {
	return &Collector{
		startTime:    time.Now(),
		counter:      counter,
		connReporter: connReporter,
	}
}

// Snapshot returns current stats.
func (c *Collector) Snapshot() Snapshot {
	active := 0
	if c.counter != nil {
		active = c.counter.SessionCount()
	}
	snap := Snapshot{
		UptimeSeconds:   int64(time.Since(c.startTime).Seconds()),
		PageViews:       c.pageViews.Load(),
		APIRequests:     c.apiRequests.Load(),
		UniqueVisitors:  c.uniqueTotal.Load(),
		SessionsCreated: c.sessionsCreated.Load(),
		SessionViews:    c.sessionViews.Load(),
		ClipsCreated:    c.clipsCreated.Load(),
		ActiveSessions:  active,
	}

	if c.connReporter != nil {
		sseTotal, sseSessions := c.connReporter.SSEStats()
		snap.SSEConnections = sseTotal
		snap.SessionsWithViewers = sseSessions
		snap.ActiveTunnels = c.connReporter.TunnelCount()
	}

	return snap
}

// RecordRequest increments api_requests and, for non-API GETs, page_views.
// Also tracks unique visitors by hashed IP.
func (c *Collector) RecordRequest(ip string, method string, path string) {
	c.apiRequests.Add(1)

	if method == "GET" && len(path) > 0 && path[0] == '/' && !isAPIPath(path) {
		c.pageViews.Add(1)
	}

	hash := hashIP(ip)
	if _, loaded := c.seen.LoadOrStore(hash, struct{}{}); !loaded {
		c.uniqueTotal.Add(1)
	}
}

// RecordSessionCreated increments sessions_created.
func (c *Collector) RecordSessionCreated() {
	c.sessionsCreated.Add(1)
}

// RecordSessionView increments session_views (visitor loaded a session page).
func (c *Collector) RecordSessionView() {
	c.sessionViews.Add(1)
}

// RecordClipCreated increments clips_created. Because clip payloads are
// peer-to-peer over WebRTC and never reach the server, this counter is
// driven by a server-visible proxy: the API handler increments it when a
// "description" signal carries an SDP "offer", which corresponds to a peer
// initiating a new WebRTC negotiation to share something. Each transfer
// session typically produces one offer, but reconnects and renegotiations
// can over-count; long-lived data channels carrying many clips will
// under-count. Use this as a directional signal of share activity, not an
// exact clip count.
func (c *Collector) RecordClipCreated() {
	c.clipsCreated.Add(1)
}

// ResetVisitorMap clears the dedup map. The unique_visitors counter keeps its value.
func (c *Collector) ResetVisitorMap() {
	c.seen.Range(func(key, _ any) bool {
		c.seen.Delete(key)
		return true
	})
}

// StartDailyReset resets the visitor dedup map every 24h. Cancel ctx to stop.
func (c *Collector) StartDailyReset(ctx context.Context) {
	ticker := newTicker(dailyResetInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.ResetVisitorMap()
		}
	}
}

func isAPIPath(path string) bool {
	return len(path) >= 4 && path[:4] == "/api"
}

func hashIP(ip string) string {
	h := sha256.Sum256([]byte(ip))
	return hex.EncodeToString(h[:])
}

