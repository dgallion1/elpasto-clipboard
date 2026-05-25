// backend/internal/stats/stats_test.go
package stats

import (
	"context"
	"testing"
	"time"
)

func TestNewCollector(t *testing.T) {
	c := New(nil, nil)
	if c == nil {
		t.Fatal("expected non-nil collector")
	}
	snap := c.Snapshot()
	if snap.UptimeSeconds < 0 {
		t.Errorf("expected non-negative uptime, got %d", snap.UptimeSeconds)
	}
	if snap.PageViews != 0 || snap.APIRequests != 0 || snap.UniqueVisitors != 0 {
		t.Error("expected zero counters on fresh collector")
	}
}

func TestRecordRequest(t *testing.T) {
	c := New(nil, nil)

	c.RecordRequest("1.2.3.4", "GET", "/some-token")
	c.RecordRequest("1.2.3.4", "GET", "/api/sessions")
	c.RecordRequest("5.6.7.8", "POST", "/api/sessions")

	snap := c.Snapshot()
	if snap.APIRequests != 3 {
		t.Errorf("api_requests: got %d, want 3", snap.APIRequests)
	}
	if snap.PageViews != 1 {
		t.Errorf("page_views: got %d, want 1 (only non-API GETs)", snap.PageViews)
	}
	if snap.UniqueVisitors != 2 {
		t.Errorf("unique_visitors: got %d, want 2", snap.UniqueVisitors)
	}
}

func TestDuplicateIPNotCounted(t *testing.T) {
	c := New(nil, nil)
	c.RecordRequest("1.2.3.4", "GET", "/x")
	c.RecordRequest("1.2.3.4", "GET", "/y")

	snap := c.Snapshot()
	if snap.UniqueVisitors != 1 {
		t.Errorf("unique_visitors: got %d, want 1", snap.UniqueVisitors)
	}
}

func TestResetVisitorMap(t *testing.T) {
	c := New(nil, nil)
	c.RecordRequest("1.2.3.4", "GET", "/x")
	c.ResetVisitorMap()
	// Same IP after reset — should increment unique count again
	c.RecordRequest("1.2.3.4", "GET", "/y")

	snap := c.Snapshot()
	if snap.UniqueVisitors != 2 {
		t.Errorf("unique_visitors after reset: got %d, want 2", snap.UniqueVisitors)
	}
}

func TestDomainCounters(t *testing.T) {
	c := New(nil, nil)
	c.RecordSessionCreated()
	c.RecordSessionCreated()
	c.RecordSessionView()
	c.RecordSessionView()
	c.RecordClipCreated()
	c.RecordClipCreated()
	c.RecordClipCreated()
	c.RecordFileUpload()

	snap := c.Snapshot()
	if snap.SessionsCreated != 2 {
		t.Errorf("sessions_created: got %d, want 2", snap.SessionsCreated)
	}
	if snap.SessionViews != 2 {
		t.Errorf("session_views: got %d, want 2", snap.SessionViews)
	}
	if snap.ClipsCreated != 3 {
		t.Errorf("clips_created: got %d, want 3", snap.ClipsCreated)
	}
	if snap.FileUploads != 1 {
		t.Errorf("file_uploads: got %d, want 1", snap.FileUploads)
	}
}

type mockCounter int

func (m mockCounter) SessionCount() int { return int(m) }

func TestActiveSessionsFromCounter(t *testing.T) {
	c := New(mockCounter(7), nil)
	snap := c.Snapshot()
	if snap.ActiveSessions != 7 {
		t.Errorf("active_sessions: got %d, want 7", snap.ActiveSessions)
	}
}

func TestStartDailyReset(t *testing.T) {
	oldInterval := dailyResetInterval
	t.Cleanup(func() {
		dailyResetInterval = oldInterval
	})

	dailyResetInterval = 10 * time.Millisecond
	c := New(nil, nil)
	c.RecordRequest("1.2.3.4", "GET", "/x")

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		c.StartDailyReset(ctx)
		close(done)
	}()

	time.Sleep(20 * time.Millisecond)
	c.RecordRequest("1.2.3.4", "GET", "/y")

	snap := c.Snapshot()
	if snap.UniqueVisitors != 2 {
		t.Fatalf("unique_visitors after reset = %d, want 2", snap.UniqueVisitors)
	}

	cancel()
	<-done
}

type mockConnectionReporter struct {
	sseTotal    int
	sseSessions int
	tunnelTotal int
}

func (m *mockConnectionReporter) SSEStats() (int, int) {
	return m.sseTotal, m.sseSessions
}

func (m *mockConnectionReporter) TunnelCount() int {
	return m.tunnelTotal
}

func TestSnapshotWithConnections(t *testing.T) {
	reporter := &mockConnectionReporter{
		sseTotal:    3,
		sseSessions: 1,
		tunnelTotal: 1,
	}
	c := New(mockCounter(5), reporter)

	snap := c.Snapshot()
	if snap.SSEConnections != 3 {
		t.Errorf("sse_connections: got %d, want 3", snap.SSEConnections)
	}
	if snap.SessionsWithViewers != 1 {
		t.Errorf("sessions_with_viewers: got %d, want 1", snap.SessionsWithViewers)
	}
	if snap.ActiveTunnels != 1 {
		t.Errorf("active_tunnels: got %d, want 1", snap.ActiveTunnels)
	}
}

func TestSnapshotNilCounter(t *testing.T) {
	// Nil counter should result in ActiveSessions = 0.
	c := New(nil, nil)
	snap := c.Snapshot()
	if snap.ActiveSessions != 0 {
		t.Errorf("ActiveSessions with nil counter = %d, want 0", snap.ActiveSessions)
	}
}

func TestSnapshotNilConnReporter(t *testing.T) {
	// Nil connReporter should result in zero connection stats and no Connections map.
	c := New(mockCounter(3), nil)
	snap := c.Snapshot()
	if snap.SSEConnections != 0 {
		t.Errorf("SSEConnections with nil reporter = %d, want 0", snap.SSEConnections)
	}
	if snap.ActiveTunnels != 0 {
		t.Errorf("ActiveTunnels with nil reporter = %d, want 0", snap.ActiveTunnels)
	}
	if snap.SessionsWithViewers != 0 {
		t.Errorf("SessionsWithViewers with nil reporter = %d, want 0", snap.SessionsWithViewers)
	}
}

func TestRecordRequestPageViewVariants(t *testing.T) {
	c := New(nil, nil)

	// POST to non-API path should NOT count as page view.
	c.RecordRequest("1.1.1.1", "POST", "/some-page")
	snap := c.Snapshot()
	if snap.PageViews != 0 {
		t.Errorf("POST to non-API path should not increment page views, got %d", snap.PageViews)
	}

	// GET to /api/... should NOT count as page view.
	c.RecordRequest("2.2.2.2", "GET", "/api/sessions")
	snap = c.Snapshot()
	if snap.PageViews != 0 {
		t.Errorf("GET to /api/* should not increment page views, got %d", snap.PageViews)
	}

	// GET to non-API path SHOULD count as page view.
	c.RecordRequest("3.3.3.3", "GET", "/my-session-token")
	snap = c.Snapshot()
	if snap.PageViews != 1 {
		t.Errorf("GET to non-API path should increment page views, got %d", snap.PageViews)
	}

	// All three should increment API requests.
	if snap.APIRequests != 3 {
		t.Errorf("APIRequests = %d, want 3", snap.APIRequests)
	}

	// Three distinct IPs.
	if snap.UniqueVisitors != 3 {
		t.Errorf("UniqueVisitors = %d, want 3", snap.UniqueVisitors)
	}
}

func TestRecordRequestSameIPMultipleTimes(t *testing.T) {
	c := New(nil, nil)
	c.RecordRequest("10.0.0.1", "GET", "/page1")
	c.RecordRequest("10.0.0.1", "GET", "/page2")
	c.RecordRequest("10.0.0.1", "GET", "/page3")

	snap := c.Snapshot()
	if snap.UniqueVisitors != 1 {
		t.Errorf("same IP should only be counted once, got %d", snap.UniqueVisitors)
	}
	if snap.PageViews != 3 {
		t.Errorf("PageViews = %d, want 3", snap.PageViews)
	}
	if snap.APIRequests != 3 {
		t.Errorf("APIRequests = %d, want 3", snap.APIRequests)
	}
}

func TestRecordFileUpload(t *testing.T) {
	c := New(nil, nil)
	c.RecordFileUpload()
	c.RecordFileUpload()
	c.RecordFileUpload()
	snap := c.Snapshot()
	if snap.FileUploads != 3 {
		t.Errorf("FileUploads = %d, want 3", snap.FileUploads)
	}
}

func TestIsAPIPath(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		{"/api/sessions", true},
		{"/api", true},
		{"/api/", true},
		{"/apifoo", true},
		{"/", false},
		{"/some-token", false},
		{"/ap", false},
		{"", false},
	}
	for _, tt := range tests {
		if got := isAPIPath(tt.path); got != tt.want {
			t.Errorf("isAPIPath(%q) = %v, want %v", tt.path, got, tt.want)
		}
	}
}

func TestHashIP(t *testing.T) {
	// hashIP is deterministic.
	h1 := hashIP("192.168.1.1")
	h2 := hashIP("192.168.1.1")
	if h1 != h2 {
		t.Fatalf("hashIP not deterministic: %q != %q", h1, h2)
	}
	// Different IPs produce different hashes.
	h3 := hashIP("10.0.0.1")
	if h1 == h3 {
		t.Fatalf("hashIP collision: %q == %q", h1, h3)
	}
}

func TestRecordRequestEmptyPath(t *testing.T) {
	c := New(nil, nil)
	// Empty path should not count as a page view (len check fails).
	c.RecordRequest("1.2.3.4", "GET", "")
	snap := c.Snapshot()
	if snap.PageViews != 0 {
		t.Errorf("empty path should not count as page view, got %d", snap.PageViews)
	}
	if snap.APIRequests != 1 {
		t.Errorf("APIRequests = %d, want 1", snap.APIRequests)
	}
}

