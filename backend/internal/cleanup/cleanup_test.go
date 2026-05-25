package cleanup

import (
	"context"
	"io"
	"log"
	"strings"
	"testing"
	"time"

	"elpasto/backend/internal/store"
)

func TestRunAndStart(t *testing.T) {
	metaStore := store.New(24)
	runner := New(metaStore, log.New(io.Discard, "", 0))

	session, err := metaStore.CreateSession()
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	metaStore.SetSessionExpiry(session.ID, time.Now().Add(-time.Minute))

	removed, err := runner.Run()
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if removed != 1 {
		t.Fatalf("removed = %d, want 1", removed)
	}

	next, err := metaStore.CreateSession()
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	metaStore.SetSessionExpiry(next.ID, time.Now().Add(-time.Minute))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runner.Start(ctx, 10*time.Millisecond)

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if metaStore.GetSessionByID(next.ID) == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}

	t.Fatal("expected Start to remove expired session")
}

func TestRunNoExpiredSessions(t *testing.T) {
	metaStore := store.New(24)
	runner := New(metaStore, log.New(io.Discard, "", 0))

	// Create a session but don't expire it.
	if _, err := metaStore.CreateSession(); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	removed, err := runner.Run()
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if removed != 0 {
		t.Fatalf("removed = %d, want 0", removed)
	}
}

func TestRunExpiredSession(t *testing.T) {
	metaStore := store.New(24)
	runner := New(metaStore, log.New(io.Discard, "", 0))

	session, err := metaStore.CreateSession()
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	// Expire the session.
	metaStore.SetSessionExpiry(session.ID, time.Now().Add(-time.Minute))

	removed, err := runner.Run()
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if removed != 1 {
		t.Fatalf("removed = %d, want 1", removed)
	}

	// Session should be gone from the store.
	if metaStore.GetSessionByToken(session.Token) != nil {
		t.Fatal("expected expired session to be removed from store")
	}
}

func TestStartContextCancellation(t *testing.T) {
	metaStore := store.New(24)
	runner := New(metaStore, log.New(io.Discard, "", 0))

	ctx, cancel := context.WithCancel(context.Background())
	runner.Start(ctx, 100*time.Millisecond)

	// Cancel immediately — should not panic or hang.
	cancel()
	time.Sleep(50 * time.Millisecond)
}

func TestStartLogsCleanupErrors(t *testing.T) {
	// Exercise the removed > 0 log line in Start.
	metaStore := store.New(24)

	// Use a channel-based writer to avoid data races on the log buffer.
	logCh := make(chan string, 10)
	logWriter := &chanWriter{ch: logCh}
	runner := New(metaStore, log.New(logWriter, "", 0))

	// Create and expire a session.
	session, err := metaStore.CreateSession()
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	metaStore.SetSessionExpiry(session.ID, time.Now().Add(-time.Minute))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runner.Start(ctx, 10*time.Millisecond)

	// Wait for Start to pick up the expired session.
	deadline := time.After(time.Second)
	for {
		select {
		case msg := <-logCh:
			if strings.Contains(msg, "periodic cleanup: removed") {
				return
			}
		case <-deadline:
			t.Fatal("expected cleanup log message within 1s")
		}
	}
}

// chanWriter sends each Write call as a string to a channel (race-free log capture).
type chanWriter struct {
	ch chan<- string
}

func (w *chanWriter) Write(p []byte) (int, error) {
	w.ch <- string(p)
	return len(p), nil
}
