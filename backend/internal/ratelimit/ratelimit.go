package ratelimit

import (
	"sync"
	"time"
)

type Result struct {
	Allowed   bool
	Remaining int
	ResetAt   time.Time
}

type entry struct {
	count   int
	resetAt time.Time
}

type Limiter struct {
	mu        sync.Mutex
	buckets   map[string]entry
	lastSweep time.Time
	now       func() time.Time
}

func New() *Limiter {
	return &Limiter{
		buckets:   make(map[string]entry),
		lastSweep: time.Now(),
		now:       time.Now,
	}
}

func (l *Limiter) Check(key string, maxRequests int, window time.Duration) Result {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	if now.Sub(l.lastSweep) >= time.Minute {
		for bucketKey, bucket := range l.buckets {
			if !bucket.resetAt.After(now) {
				delete(l.buckets, bucketKey)
			}
		}
		l.lastSweep = now
	}

	bucket, ok := l.buckets[key]
	if !ok || !bucket.resetAt.After(now) {
		bucket = entry{
			count:   0,
			resetAt: now.Add(window),
		}
	}

	bucket.count++
	l.buckets[key] = bucket

	if bucket.count > maxRequests {
		return Result{
			Allowed:   false,
			Remaining: 0,
			ResetAt:   bucket.resetAt,
		}
	}

	return Result{
		Allowed:   true,
		Remaining: maxRequests - bucket.count,
		ResetAt:   bucket.resetAt,
	}
}
