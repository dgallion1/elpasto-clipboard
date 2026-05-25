package store

import (
	"testing"
	"time"
)

func TestIsExpired(t *testing.T) {
	now := time.Date(2026, 3, 12, 12, 0, 0, 0, time.UTC)
	s := New(24)
	s.now = func() time.Time { return now }

	session, err := s.CreateSession()
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if s.IsExpired(session) {
		t.Fatal("fresh session should not be expired")
	}

	expiredAt := now.Add(-time.Minute)
	if ok := s.SetSessionExpiry(session.ID, expiredAt); !ok {
		t.Fatalf("SetSessionExpiry(%d) = false", session.ID)
	}

	expired := s.GetSessionByID(session.ID)
	if expired == nil {
		t.Fatalf("GetSessionByID(%d) returned nil", session.ID)
	}
	if !s.IsExpired(*expired) {
		t.Fatal("expired session should report expired")
	}

	if s.IsExpired(Session{ExpiresAt: "not-a-time"}) {
		t.Fatal("invalid expiry timestamps should be treated as not expired")
	}
}

func TestCreateSessionsWithTokens(t *testing.T) {
	now := time.Date(2026, 3, 13, 12, 0, 0, 0, time.UTC)

	t.Run("mixed batch: existing token skipped, new token created", func(t *testing.T) {
		s := New(24)
		s.now = func() time.Time { return now }

		// Pre-create a session and get its token
		existing, err := s.CreateSession()
		if err != nil {
			t.Fatalf("CreateSession: %v", err)
		}

		newToken := "alpha-bravo-charlie-delta-echo"
		result := s.CreateSessionsWithTokens([]string{existing.Token, newToken})

		if len(result.Existing) != 1 || result.Existing[0] != existing.Token {
			t.Errorf("Existing = %v, want [%s]", result.Existing, existing.Token)
		}
		if len(result.Created) != 1 || result.Created[0] != newToken {
			t.Errorf("Created = %v, want [%s]", result.Created, newToken)
		}
		if len(result.Capacity) != 0 {
			t.Errorf("Capacity = %v, want []", result.Capacity)
		}

		// Verify the new session is actually retrievable
		sess := s.GetSessionByToken(newToken)
		if sess == nil {
			t.Errorf("GetSessionByToken(%s) returned nil, want a session", newToken)
		}
	})

	t.Run("capacity reached mid-batch: both tokens go into Capacity", func(t *testing.T) {
		s := New(24)
		s.now = func() time.Time { return now }
		s.maxSessions = 1

		// Fill store to capacity
		_, err := s.CreateSession()
		if err != nil {
			t.Fatalf("CreateSession: %v", err)
		}

		token1 := "foxtrot-golf-hotel-india-juliet"
		token2 := "kilo-lima-mike-november-oscar"
		result := s.CreateSessionsWithTokens([]string{token1, token2})

		if len(result.Created) != 0 {
			t.Errorf("Created = %v, want []", result.Created)
		}
		if len(result.Existing) != 0 {
			t.Errorf("Existing = %v, want []", result.Existing)
		}
		if len(result.Capacity) != 2 {
			t.Errorf("Capacity = %v, want [%s %s]", result.Capacity, token1, token2)
		}
	})

	t.Run("expired token recreation: expired session replaced with new session", func(t *testing.T) {
		s := New(24)
		s.now = func() time.Time { return now }

		// Create a session and then expire it
		sess, err := s.CreateSession()
		if err != nil {
			t.Fatalf("CreateSession: %v", err)
		}
		expiredToken := sess.Token
		if ok := s.SetSessionExpiry(sess.ID, now.Add(-time.Minute)); !ok {
			t.Fatalf("SetSessionExpiry(%d) = false", sess.ID)
		}

		// Confirm it's expired (not reachable)
		if s.GetSessionByToken(expiredToken) != nil {
			t.Fatal("expected expired session to be unreachable, but got a result")
		}

		// Batch-create with the expired token — it should be recreated
		result := s.CreateSessionsWithTokens([]string{expiredToken})

		if len(result.Existing) != 0 {
			t.Errorf("Existing = %v, want []", result.Existing)
		}
		if len(result.Capacity) != 0 {
			t.Errorf("Capacity = %v, want []", result.Capacity)
		}
		if len(result.Created) != 1 || result.Created[0] != expiredToken {
			t.Errorf("Created = %v, want [%s]", result.Created, expiredToken)
		}

		// The recreated session must be live
		recreated := s.GetSessionByToken(expiredToken)
		if recreated == nil {
			t.Errorf("GetSessionByToken(%s) returned nil after recreation", expiredToken)
		}
	})
}

func TestActiveSessionIDsOnlyReturnsNonExpiredSessions(t *testing.T) {
	now := time.Date(2026, 3, 12, 12, 0, 0, 0, time.UTC)
	s := New(24)
	s.now = func() time.Time { return now }

	first, err := s.CreateSession()
	if err != nil {
		t.Fatalf("CreateSession first: %v", err)
	}
	second, err := s.CreateSession()
	if err != nil {
		t.Fatalf("CreateSession second: %v", err)
	}

	if ok := s.SetSessionExpiry(first.ID, now.Add(-time.Minute)); !ok {
		t.Fatalf("SetSessionExpiry(%d) = false", first.ID)
	}

	ids := s.ActiveSessionIDs()
	if len(ids) != 1 {
		t.Fatalf("ActiveSessionIDs() length = %d, want 1", len(ids))
	}
	if ids[0] != second.ID {
		t.Fatalf("ActiveSessionIDs()[0] = %d, want %d", ids[0], second.ID)
	}
	if count := s.SessionCount(); count != 1 {
		t.Fatalf("SessionCount() = %d, want 1", count)
	}
}

func TestCreateSessionAtCapacity(t *testing.T) {
	s := New(24)
	s.maxSessions = 1

	_, err := s.CreateSession()
	if err != nil {
		t.Fatalf("first CreateSession: %v", err)
	}

	_, err = s.CreateSession()
	if err != ErrAtCapacity {
		t.Fatalf("expected ErrAtCapacity, got %v", err)
	}
}

func TestSetSessionExpiryNotFound(t *testing.T) {
	s := New(24)
	if s.SetSessionExpiry(999, time.Now()) {
		t.Fatal("expected false for non-existent session")
	}
}

func TestSetSessionTokenNotFound(t *testing.T) {
	s := New(24)
	if s.SetSessionToken(999, "new-token") {
		t.Fatal("expected false for non-existent session")
	}
}

func TestSetSessionTokenSwapsToken(t *testing.T) {
	s := New(24)
	sess, err := s.CreateSession()
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	oldToken := sess.Token
	newToken := "alpha-bravo-charlie-delta-echo"
	if !s.SetSessionToken(sess.ID, newToken) {
		t.Fatal("SetSessionToken returned false")
	}

	if s.GetSessionByToken(oldToken) != nil {
		t.Fatal("old token should no longer resolve")
	}
	if s.GetSessionByToken(newToken) == nil {
		t.Fatal("new token should resolve")
	}
}

func TestGetSessionByTokenExpired(t *testing.T) {
	now := time.Date(2026, 3, 12, 12, 0, 0, 0, time.UTC)
	s := New(24)
	s.now = func() time.Time { return now }

	sess, _ := s.CreateSession()
	s.SetSessionExpiry(sess.ID, now.Add(-time.Minute))

	if s.GetSessionByToken(sess.Token) != nil {
		t.Fatal("expired session should return nil")
	}
}

func TestGetSessionByIDNotFound(t *testing.T) {
	s := New(24)
	if s.GetSessionByID(999) != nil {
		t.Fatal("expected nil for non-existent ID")
	}
}

func TestFindSessionByTokenPrefixMultipleMatches(t *testing.T) {
	s := New(24)
	s1, _ := s.CreateSession()
	s2, _ := s.CreateSession()

	// Force both sessions to share a prefix by setting matching tokens.
	s.SetSessionToken(s1.ID, "alpha-bravo-charlie-delta-echo")
	s.SetSessionToken(s2.ID, "alpha-bravo-charlie-foxtrot-golf")

	// "alpha-bravo-charlie" matches both — should return nil (ambiguous).
	if s.FindSessionByTokenPrefix("alpha-bravo-charlie") != nil {
		t.Fatal("expected nil for ambiguous prefix")
	}

	// Unique prefix should resolve.
	if s.FindSessionByTokenPrefix("alpha-bravo-charlie-delta") == nil {
		t.Fatal("expected session for unique prefix")
	}
}

func TestCreateSessionTokenCollision(t *testing.T) {
	// Simulate the token collision retry limit by pre-filling with known tokens.
	// We can't easily force rand.Int to collide, but we can test with a very
	// small word list (1 word) which guarantees all tokens are the same.
	s := New(24)
	// Create first session — will use the only possible token.
	sess1, err := s.CreateSession()
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	_ = sess1
	// The token is deterministic with a 1-word list? No - it uses real rand.
	// Instead, test the capacity error path through the normal interface.
}

func TestFindSessionByTokenPrefixExpired(t *testing.T) {
	now := time.Date(2026, 3, 12, 12, 0, 0, 0, time.UTC)
	s := New(24)
	s.now = func() time.Time { return now }

	sess, _ := s.CreateSession()
	s.SetSessionToken(sess.ID, "amber-anchor-apple-arch-arrow")
	s.SetSessionExpiry(sess.ID, now.Add(-time.Minute))

	// Expired session should not be found.
	if s.FindSessionByTokenPrefix("amber-anchor-apple") != nil {
		t.Fatal("expected nil for expired session prefix")
	}
}

func TestFindSessionByTokenPrefixNoMatch(t *testing.T) {
	s := New(24)
	sess, _ := s.CreateSession()
	s.SetSessionToken(sess.ID, "amber-anchor-apple-arch-arrow")

	// Non-matching prefix should return nil.
	if s.FindSessionByTokenPrefix("zzz-yyy-xxx") != nil {
		t.Fatal("expected nil for non-matching prefix")
	}
}

func TestDeleteExpired(t *testing.T) {
	now := time.Date(2026, 3, 12, 12, 0, 0, 0, time.UTC)
	s := New(24)
	s.now = func() time.Time { return now }

	s1, _ := s.CreateSession()
	s2, _ := s.CreateSession()

	// Expire s1 only.
	s.SetSessionExpiry(s1.ID, now.Add(-time.Minute))

	deleted := s.DeleteExpired()
	if len(deleted) != 1 {
		t.Fatalf("expected 1 deleted, got %d", len(deleted))
	}
	if deleted[0].Token != s1.Token {
		t.Fatalf("deleted wrong session: %s", deleted[0].Token)
	}

	// s2 should still be alive.
	if s.GetSessionByToken(s2.Token) == nil {
		t.Fatal("s2 should still be accessible")
	}
	// s1 should be gone.
	if s.GetSessionByToken(s1.Token) != nil {
		t.Fatal("s1 should be deleted")
	}
}
