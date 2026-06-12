package store

import (
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"elpasto/backend/internal/tokens"
)

// Session is the external representation returned to callers.
type Session struct {
	ID        int64  `json:"id"`
	Token     string `json:"token"`
	CreatedAt string `json:"created_at"`
	ExpiresAt string `json:"expires_at"`
}

// Internal records — never exposed outside the store.

type sessionRecord struct {
	id        int64
	token     string
	createdAt time.Time
	expiresAt time.Time
}

const DefaultMaxSessions = 10000

// DefaultMaxSnapshotBytes caps the on-disk snapshot size accepted at restore.
// ~10k sessions of fixed-shape metadata is a few MB; 64 MiB is generous while
// preventing a tampered/corrupt file from forcing an unbounded allocation.
const DefaultMaxSnapshotBytes int64 = 64 << 20

// ErrAtCapacity is returned when the session count cap is reached.
var ErrAtCapacity = fmt.Errorf("session capacity reached")

// Store is a thread-safe in-memory metadata store for sessions and clips.
type Store struct {
	mu               sync.RWMutex
	sessionsByToken  map[string]*sessionRecord
	sessionsByID     map[int64]*sessionRecord
	nextSessionID    atomic.Int64
	now              func() time.Time
	generateToken    func() (string, error)
	expiryHours      int
	maxSessions      int
	maxSnapshotBytes int64
	dirty            atomic.Bool
}

// New creates a new in-memory store.
func New(expiryHours int) *Store {
	s := &Store{
		sessionsByToken:  make(map[string]*sessionRecord),
		sessionsByID:     make(map[int64]*sessionRecord),
		now:              func() time.Time { return time.Now().UTC() },
		generateToken:    tokens.Generate,
		expiryHours:      expiryHours,
		maxSessions:      DefaultMaxSessions,
		maxSnapshotBytes: DefaultMaxSnapshotBytes,
	}
	return s
}

// MarkDirty flags the store as having unsaved changes.
func (s *Store) MarkDirty() {
	s.dirty.Store(true)
}
