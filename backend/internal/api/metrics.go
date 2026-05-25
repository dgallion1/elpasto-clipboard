package api

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"elpasto/backend/internal/stats"
)

// statsPromCollector adapts the in-memory stats.Collector into a
// prometheus.Collector. It re-reads a snapshot on every scrape so the
// existing atomic counters remain the source of truth and stats package
// tests stay unaffected.
type statsPromCollector struct {
	src *stats.Collector

	uptime          *prometheus.Desc
	pageViews       *prometheus.Desc
	apiRequests     *prometheus.Desc
	uniqueVisitors  *prometheus.Desc
	sessionsCreated *prometheus.Desc
	sessionViews    *prometheus.Desc
	clipsCreated    *prometheus.Desc
	activeSessions  *prometheus.Desc
	sseConnections  *prometheus.Desc
	activeTunnels   *prometheus.Desc
	sessionsViewers *prometheus.Desc
}

func newStatsPromCollector(src *stats.Collector) *statsPromCollector {
	return &statsPromCollector{
		src:             src,
		uptime:          prometheus.NewDesc("elpasto_uptime_seconds", "Server uptime in seconds.", nil, nil),
		pageViews:       prometheus.NewDesc("elpasto_page_views_total", "Total non-API GET page views since process start.", nil, nil),
		apiRequests:     prometheus.NewDesc("elpasto_api_requests_total", "Total API requests since process start.", nil, nil),
		uniqueVisitors:  prometheus.NewDesc("elpasto_unique_visitors", "Unique visitors today (resets daily, deduped by hashed IP).", nil, nil),
		sessionsCreated: prometheus.NewDesc("elpasto_sessions_created_total", "Total sessions created since process start.", nil, nil),
		sessionViews:    prometheus.NewDesc("elpasto_session_views_total", "Total session-page views since process start.", nil, nil),
		clipsCreated:    prometheus.NewDesc("elpasto_clips_created_total", "Total SDP-offer signals seen (proxy for clip-share intents).", nil, nil),
		activeSessions:  prometheus.NewDesc("elpasto_active_sessions", "Current number of unexpired sessions.", nil, nil),
		sseConnections:  prometheus.NewDesc("elpasto_sse_connections", "Current number of open Server-Sent Events connections.", nil, nil),
		activeTunnels:   prometheus.NewDesc("elpasto_active_tunnels", "Current number of registered server-relay tunnels.", nil, nil),
		sessionsViewers: prometheus.NewDesc("elpasto_sessions_with_viewers", "Current number of sessions that have at least one SSE subscriber.", nil, nil),
	}
}

func (c *statsPromCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- c.uptime
	ch <- c.pageViews
	ch <- c.apiRequests
	ch <- c.uniqueVisitors
	ch <- c.sessionsCreated
	ch <- c.sessionViews
	ch <- c.clipsCreated
	ch <- c.activeSessions
	ch <- c.sseConnections
	ch <- c.activeTunnels
	ch <- c.sessionsViewers
}

func (c *statsPromCollector) Collect(ch chan<- prometheus.Metric) {
	snap := c.src.Snapshot()
	ch <- prometheus.MustNewConstMetric(c.uptime, prometheus.GaugeValue, float64(snap.UptimeSeconds))
	ch <- prometheus.MustNewConstMetric(c.pageViews, prometheus.CounterValue, float64(snap.PageViews))
	ch <- prometheus.MustNewConstMetric(c.apiRequests, prometheus.CounterValue, float64(snap.APIRequests))
	ch <- prometheus.MustNewConstMetric(c.uniqueVisitors, prometheus.GaugeValue, float64(snap.UniqueVisitors))
	ch <- prometheus.MustNewConstMetric(c.sessionsCreated, prometheus.CounterValue, float64(snap.SessionsCreated))
	ch <- prometheus.MustNewConstMetric(c.sessionViews, prometheus.CounterValue, float64(snap.SessionViews))
	ch <- prometheus.MustNewConstMetric(c.clipsCreated, prometheus.CounterValue, float64(snap.ClipsCreated))
	ch <- prometheus.MustNewConstMetric(c.activeSessions, prometheus.GaugeValue, float64(snap.ActiveSessions))
	ch <- prometheus.MustNewConstMetric(c.sseConnections, prometheus.GaugeValue, float64(snap.SSEConnections))
	ch <- prometheus.MustNewConstMetric(c.activeTunnels, prometheus.GaugeValue, float64(snap.ActiveTunnels))
	ch <- prometheus.MustNewConstMetric(c.sessionsViewers, prometheus.GaugeValue, float64(snap.SessionsWithViewers))
}

// newMetricsHandler builds an http.Handler exposing Prometheus metrics for
// the Go runtime, the process, and the elpasto stats snapshot. The handler
// is gated by STATS_DASHBOARD_KEY: callers without the key get 404 to
// avoid leaking endpoint existence.
func (s *Server) newMetricsHandler() http.Handler {
	registry := prometheus.NewRegistry()
	registry.MustRegister(collectors.NewGoCollector())
	registry.MustRegister(collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	registry.MustRegister(newStatsPromCollector(s.stats))

	prom := promhttp.HandlerFor(registry, promhttp.HandlerOpts{
		Registry: registry,
	})

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.statsKeyAuthorized(r) {
			writeError(w, http.StatusNotFound, "Not found")
			return
		}
		prom.ServeHTTP(w, r)
	})
}
