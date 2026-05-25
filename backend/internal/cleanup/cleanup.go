package cleanup

import (
	"context"
	"log"
	"time"

	"elpasto/backend/internal/store"
	"elpasto/backend/internal/storage"
)

type Runner struct {
	store   *store.Store
	storage *storage.Store
	logger  *log.Logger
}

func New(s *store.Store, blobStore *storage.Store, logger *log.Logger) *Runner {
	return &Runner{
		store:   s,
		storage: blobStore,
		logger:  logger,
	}
}

func (r *Runner) Run() (int, error) {
	expired, fileSets := r.store.DeleteExpired()

	for _, fs := range fileSets {
		for _, key := range fs.StorageKeys {
			r.storage.DeleteFile(fs.SessionID, key)
		}
	}

	// Also delete session directories for expired sessions (covers files with no clip record).
	for _, session := range expired {
		r.storage.DeleteSessionFiles(session.ID)
	}

	return len(expired), nil
}

func (r *Runner) Start(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	go func() {
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				removed, err := r.Run()
				if err != nil {
					r.logger.Printf("cleanup failed: %v", err)
					continue
				}
				if removed > 0 {
					r.logger.Printf("periodic cleanup: removed %d expired sessions", removed)
				}
			}
		}
	}()
}
