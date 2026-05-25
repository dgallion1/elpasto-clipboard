package store

import (
	"time"
)

func (r *sessionRecord) snapshot() Session {
	return Session{
		ID:        r.id,
		Token:     r.token,
		CreatedAt: r.createdAt.Format(time.RFC3339),
		ExpiresAt: r.expiresAt.Format(time.RFC3339),
	}
}
