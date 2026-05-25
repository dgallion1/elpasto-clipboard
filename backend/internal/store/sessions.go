package store

import (
	"fmt"
	"strings"
	"time"
)

// CreateSession generates a new session with a random token.
func (s *Store) CreateSession() (Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	activeCount := 0
	for _, rec := range s.sessionsByID {
		if rec.expiresAt.After(now) {
			activeCount++
		}
	}
	if activeCount >= s.maxSessions {
		return Session{}, ErrAtCapacity
	}

	var token string
	for attempts := 0; attempts < 8; attempts++ {
		candidate, err := s.generateToken()
		if err != nil {
			return Session{}, fmt.Errorf("generate token: %w", err)
		}
		if _, exists := s.sessionsByToken[candidate]; exists {
			continue
		}
		token = candidate
		break
	}
	if token == "" {
		return Session{}, fmt.Errorf("generate token: collision retry limit reached")
	}

	expiresAt := now.Add(time.Duration(s.expiryHours) * time.Hour)
	id := s.nextSessionID.Add(1)

	rec := &sessionRecord{
		id:         id,
		token:      token,
		createdAt:  now,
		expiresAt:  expiresAt,
	}

	s.sessionsByToken[token] = rec
	s.sessionsByID[id] = rec
	s.dirty.Store(true)

	return rec.snapshot(), nil
}

// BatchResult holds the outcome of a CreateSessionsWithTokens call.
type BatchResult struct {
	Created  []string
	Existing []string
	Capacity []string
}

// CreateSessionsWithTokens creates sessions for the given tokens in a single
// write-locked operation. Tokens that already have an active session go to
// Existing; tokens whose session has expired are recreated and go to Created;
// tokens that cannot be created because the store is at capacity go to Capacity.
func (s *Store) CreateSessionsWithTokens(tokens []string) BatchResult {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	expiresAt := now.Add(time.Duration(s.expiryHours) * time.Hour)

	// Count only active (non-expired) sessions for capacity purposes.
	activeCount := 0
	for _, rec := range s.sessionsByID {
		if rec.expiresAt.After(now) {
			activeCount++
		}
	}

	var result BatchResult

	for _, token := range tokens {
		if existing, ok := s.sessionsByToken[token]; ok {
			if existing.expiresAt.After(now) {
				// Active record exists — report as existing.
				result.Existing = append(result.Existing, token)
				continue
			}
			// Expired record — remove it so we can recreate.
			delete(s.sessionsByToken, token)
			delete(s.sessionsByID, existing.id)
		}

		if activeCount >= s.maxSessions {
			result.Capacity = append(result.Capacity, token)
			continue
		}

		id := s.nextSessionID.Add(1)
		rec := &sessionRecord{
			id:        id,
			token:     token,
			createdAt: now,
			expiresAt: expiresAt,
		}
		s.sessionsByToken[token] = rec
		s.sessionsByID[id] = rec
		activeCount++
		result.Created = append(result.Created, token)
	}

	if len(result.Created) > 0 {
		s.dirty.Store(true)
	}

	return result
}

// GetSessionByToken returns a copy of the session or nil if not found/expired.
func (s *Store) GetSessionByToken(token string) *Session {
	s.mu.RLock()
	defer s.mu.RUnlock()

	rec := s.sessionsByToken[token]
	if rec == nil || !rec.expiresAt.After(s.now()) {
		return nil
	}
	snap := rec.snapshot()
	return &snap
}

// FindSessionByTokenPrefix returns the unique active session matching the prefix.
// Returns nil when there are zero or multiple matches.
func (s *Store) FindSessionByTokenPrefix(prefix string) *Session {
	s.mu.RLock()
	defer s.mu.RUnlock()

	now := s.now()
	matchCount := 0
	var match *Session

	for token, rec := range s.sessionsByToken {
		if !rec.expiresAt.After(now) || !strings.HasPrefix(token, prefix+"-") {
			continue
		}

		matchCount++
		if matchCount > 1 {
			return nil
		}

		snap := rec.snapshot()
		match = &snap
	}

	return match
}

// GetSessionByID returns a copy of the session or nil if not found.
// Does not filter by expiry; used internally for cleanup.
func (s *Store) GetSessionByID(id int64) *Session {
	s.mu.RLock()
	defer s.mu.RUnlock()

	rec := s.sessionsByID[id]
	if rec == nil {
		return nil
	}
	snap := rec.snapshot()
	return &snap
}

// SetSessionExpiry overrides the expiry time for a session. Returns false if not found.
// Intended for tests.
func (s *Store) SetSessionExpiry(sessionID int64, expiresAt time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	rec := s.sessionsByID[sessionID]
	if rec == nil {
		return false
	}
	rec.expiresAt = expiresAt.UTC()
	return true
}

// SetSessionToken overrides a session token. Intended for tests.
func (s *Store) SetSessionToken(sessionID int64, token string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	rec := s.sessionsByID[sessionID]
	if rec == nil {
		return false
	}

	delete(s.sessionsByToken, rec.token)
	rec.token = token
	s.sessionsByToken[token] = rec
	return true
}

// DeleteExpired removes all expired sessions.
// Returns the deleted sessions (snapshots).
func (s *Store) DeleteExpired() []Session {
	now := s.now()

	s.mu.Lock()
	defer s.mu.Unlock()

	var deleted []Session

	for token, rec := range s.sessionsByToken {
		if !rec.expiresAt.After(now) {
			deleted = append(deleted, rec.snapshot())
			s.deleteSessionLocked(token, rec)
		}
	}

	if len(deleted) > 0 {
		s.dirty.Store(true)
	}

	return deleted
}

// deleteSessionLocked removes a session. Caller must hold s.mu.
func (s *Store) deleteSessionLocked(token string, rec *sessionRecord) {
	delete(s.sessionsByToken, token)
	delete(s.sessionsByID, rec.id)
}

// IsExpired returns whether a session is past its expiry time.
func (s *Store) IsExpired(session Session) bool {
	expiresAt, err := time.Parse(time.RFC3339, session.ExpiresAt)
	if err != nil {
		return false
	}
	return !expiresAt.After(s.now())
}

// SessionCount returns the number of non-expired sessions.
func (s *Store) SessionCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()

	count := 0
	now := s.now()
	for _, rec := range s.sessionsByID {
		if rec.expiresAt.After(now) {
			count++
		}
	}
	return count
}

func (s *Store) ActiveSessionIDs() []int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()

	now := s.now()
	ids := make([]int64, 0, len(s.sessionsByID))
	for id, rec := range s.sessionsByID {
		if rec.expiresAt.After(now) {
			ids = append(ids, id)
		}
	}
	return ids
}
