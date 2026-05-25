package ratelimit

import (
	"testing"
	"time"
)

func TestCheck(t *testing.T) {
	now := time.Date(2026, 3, 11, 12, 0, 0, 0, time.UTC)
	limiter := New()
	limiter.now = func() time.Time { return now }
	limiter.lastSweep = now

	first := limiter.Check("client", 2, time.Minute)
	if !first.Allowed || first.Remaining != 1 {
		t.Fatalf("unexpected first result: %+v", first)
	}

	second := limiter.Check("client", 2, time.Minute)
	if !second.Allowed || second.Remaining != 0 {
		t.Fatalf("unexpected second result: %+v", second)
	}

	third := limiter.Check("client", 2, time.Minute)
	if third.Allowed || third.Remaining != 0 {
		t.Fatalf("unexpected third result: %+v", third)
	}
}

func TestCheckResetsExpiredBucketAndSweepsOldEntries(t *testing.T) {
	now := time.Date(2026, 3, 11, 12, 0, 0, 0, time.UTC)
	limiter := New()
	limiter.now = func() time.Time { return now }
	limiter.lastSweep = now

	limiter.Check("expired", 1, time.Minute)
	limiter.Check("stale", 1, time.Second)

	now = now.Add(2 * time.Minute)
	result := limiter.Check("expired", 1, time.Minute)
	if !result.Allowed || result.Remaining != 0 {
		t.Fatalf("unexpected reset result: %+v", result)
	}
	if _, ok := limiter.buckets["stale"]; ok {
		t.Fatal("expected stale bucket to be swept")
	}
}
