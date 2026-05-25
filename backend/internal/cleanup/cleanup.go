package cleanup

import (
	"context"
	"log"
	"time"

	"elpasto/backend/internal/store"
)

type Runner struct {
	store  *store.Store
	logger *log.Logger
	runFn  func() (int, error) // defaults to Run; tests may override
}

func New(s *store.Store, logger *log.Logger) *Runner {
	r := &Runner{
		store:  s,
		logger: logger,
	}
	r.runFn = r.Run
	return r
}

func (r *Runner) Run() (int, error) {
	expired := r.store.DeleteExpired()
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
				removed, err := r.runFn()
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
