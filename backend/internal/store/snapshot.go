package store

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"sort"
	"time"
)

const snapshotVersion = 1

// SnapshotData is the on-disk format for persisting store state across restarts.
type SnapshotData struct {
	Version       int               `json:"version"`
	SavedAt       string            `json:"saved_at"`
	NextSessionID int64             `json:"next_session_id"`
	Sessions      []snapshotSession `json:"sessions"`
}

type snapshotSession struct {
	ID        int64  `json:"id"`
	Token     string `json:"token"`
	CreatedAt string `json:"created_at"`
	ExpiresAt string `json:"expires_at"`
}

// SaveSnapshot serializes all non-expired sessions and their clips to a file.
// Sessions whose expiry was set under a shorter config window are extended
// in-memory before filtering, so they survive restarts.
func (s *Store) SaveSnapshot(path string) error {
	s.mu.RLock()
	now := s.now()
	minExpiry := now.Add(time.Duration(s.expiryHours) * time.Hour)

	type snapshotCandidate struct {
		rec       *sessionRecord
		expiresAt time.Time
	}
	candidates := make([]snapshotCandidate, 0, len(s.sessionsByID))
	for _, rec := range s.sessionsByID {
		exp := rec.expiresAt
		if exp.Before(minExpiry) {
			exp = minExpiry
		}
		if !exp.After(now) {
			continue
		}
		candidates = append(candidates, snapshotCandidate{rec: rec, expiresAt: exp})
	}
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].rec.id < candidates[j].rec.id
	})

	var sessions []snapshotSession
	for _, c := range candidates {
		sessions = append(sessions, snapshotSession{
			ID:        c.rec.id,
			Token:     c.rec.token,
			CreatedAt: c.rec.createdAt.Format(time.RFC3339),
			ExpiresAt: c.expiresAt.Format(time.RFC3339),
		})
	}

	nextSessionID := s.nextSessionID.Load()
	s.mu.RUnlock()

	data := SnapshotData{
		Version:       snapshotVersion,
		SavedAt:       now.Format(time.RFC3339),
		NextSessionID: nextSessionID,
		Sessions:      sessions,
	}

	encoded, err := json.Marshal(data)
	if err != nil {
		return fmt.Errorf("marshal snapshot: %w", err)
	}

	if err := os.WriteFile(path, encoded, 0600); err != nil {
		return fmt.Errorf("write snapshot: %w", err)
	}

	return nil
}

// RestoreSnapshot loads sessions from a snapshot file into the store.
// Sessions whose expiry is shorter than the current config are extended.
// The snapshot file is deleted after a successful restore.
func (s *Store) RestoreSnapshot(path string) (int, int, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, 0, nil
		}
		return 0, 0, fmt.Errorf("read snapshot: %w", err)
	}

	var data SnapshotData
	if err := json.Unmarshal(raw, &data); err != nil {
		return 0, 0, fmt.Errorf("unmarshal snapshot: %w", err)
	}
	if data.Version != snapshotVersion {
		return 0, 0, fmt.Errorf("unsupported snapshot version %d", data.Version)
	}

	now := s.now()

	restoredSessions := 0

	s.mu.Lock()
	defer s.mu.Unlock()

	minExpiry := now.Add(time.Duration(s.expiryHours) * time.Hour)

	for _, ss := range data.Sessions {
		expiresAt, err := time.Parse(time.RFC3339, ss.ExpiresAt)
		if err != nil {
			continue
		}
		createdAt, err := time.Parse(time.RFC3339, ss.CreatedAt)
		if err != nil {
			continue
		}

		// Extend expiry for sessions created under a shorter expiry window,
		// including sessions that have already expired under the old config.
		if expiresAt.Before(minExpiry) {
			expiresAt = minExpiry
		}

		if !expiresAt.After(now) {
			continue
		}

		rec := &sessionRecord{
			id:        ss.ID,
			token:     ss.Token,
			createdAt: createdAt,
			expiresAt: expiresAt,
		}
		s.sessionsByToken[ss.Token] = rec
		s.sessionsByID[ss.ID] = rec
		restoredSessions++
	}

	// Advance ID counters past any restored IDs.
	if data.NextSessionID > s.nextSessionID.Load() {
		s.nextSessionID.Store(data.NextSessionID)
	}

	// Remove the snapshot file after successful restore.
	_ = os.Remove(path)

	// Mark dirty so the snapshot loop re-persists restored sessions.
	// Without this, a second restart with no mutations would find no
	// snapshot file and lose all restored sessions.
	if restoredSessions > 0 {
		s.dirty.Store(true)
	}

	return restoredSessions, 0, nil
}

// StartSnapshotLoop runs a background goroutine that periodically saves a
// snapshot when the store has been mutated. It also performs a final save
// when ctx is cancelled (e.g. during shutdown) so that sessions survive
// ungraceful restarts like `docker compose up --force-recreate`.
// The returned channel is closed after the shutdown save completes; callers
// must wait on it before exiting so the save is not interrupted.
func (s *Store) StartSnapshotLoop(ctx context.Context, path string, interval time.Duration, logger *log.Logger) <-chan struct{} {
	done := make(chan struct{})
	ticker := time.NewTicker(interval)
	go func() {
		defer close(done)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				s.saveIfDirty(path, logger, "shutdown")
				return
			case <-ticker.C:
				s.saveIfDirty(path, logger, "periodic")
			}
		}
	}()
	return done
}

func (s *Store) saveIfDirty(path string, logger *log.Logger, label string) {
	if !s.dirty.Swap(false) {
		return
	}
	if err := s.SaveSnapshot(path); err != nil {
		logger.Printf("warning: %s snapshot save failed: %v", label, err)
		s.dirty.Store(true) // retry next tick
	} else {
		logger.Printf("%s: saved session snapshot", label)
	}
}
