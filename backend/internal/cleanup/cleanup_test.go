package cleanup

import (
	"context"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"elpasto/backend/internal/storage"
	"elpasto/backend/internal/store"
)

func TestRunAndStart(t *testing.T) {
	dir := t.TempDir()
	uploadsDir := filepath.Join(dir, "uploads")
	metaStore := store.New(24)
	blobStore := storage.New(uploadsDir)
	runner := New(metaStore, blobStore, log.New(io.Discard, "", 0))

	session, err := metaStore.CreateSession()
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	metaStore.SetSessionExpiry(session.ID, time.Now().Add(-time.Minute))

	sessionDir := filepath.Join(uploadsDir, "1")
	if err := os.MkdirAll(sessionDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sessionDir, "clip.bin"), []byte("data"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	removed, err := runner.Run()
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if removed != 1 {
		t.Fatalf("removed = %d, want 1", removed)
	}
	if _, err := os.Stat(filepath.Join(uploadsDir, "1")); !os.IsNotExist(err) {
		t.Fatalf("expected session files to be removed, got err=%v", err)
	}

	next, err := metaStore.CreateSession()
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	metaStore.SetSessionExpiry(next.ID, time.Now().Add(-time.Minute))
	nextSessionDir := filepath.Join(uploadsDir, "2")
	if err := os.MkdirAll(nextSessionDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(filepath.Join(nextSessionDir, "later.bin"), []byte("data"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runner.Start(ctx, 10*time.Millisecond)

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(filepath.Join(uploadsDir, "2")); os.IsNotExist(err) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}

	t.Fatal("expected Start to remove expired session files")
}

func TestRunNoExpiredSessions(t *testing.T) {
	dir := t.TempDir()
	uploadsDir := filepath.Join(dir, "uploads")
	metaStore := store.New(24)
	blobStore := storage.New(uploadsDir)
	runner := New(metaStore, blobStore, log.New(io.Discard, "", 0))

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

func TestRunExpiredSessionWithUploads(t *testing.T) {
	dir := t.TempDir()
	uploadsDir := filepath.Join(dir, "uploads")
	metaStore := store.New(24)
	blobStore := storage.New(uploadsDir)
	runner := New(metaStore, blobStore, log.New(io.Discard, "", 0))

	session, err := metaStore.CreateSession()
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	// Create session upload directory with multiple files.
	sessionDir := filepath.Join(uploadsDir, "1")
	if err := os.MkdirAll(sessionDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	for _, name := range []string{"file1.bin", "file2.bin"} {
		if err := os.WriteFile(filepath.Join(sessionDir, name), []byte("data"), 0o600); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
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

	// Session directory should be cleaned up.
	if _, err := os.Stat(sessionDir); !os.IsNotExist(err) {
		t.Fatalf("expected session directory to be removed, err=%v", err)
	}
}

func TestStartContextCancellation(t *testing.T) {
	dir := t.TempDir()
	uploadsDir := filepath.Join(dir, "uploads")
	metaStore := store.New(24)
	blobStore := storage.New(uploadsDir)
	runner := New(metaStore, blobStore, log.New(io.Discard, "", 0))

	ctx, cancel := context.WithCancel(context.Background())
	runner.Start(ctx, 100*time.Millisecond)

	// Cancel immediately — should not panic or hang.
	cancel()
	time.Sleep(50 * time.Millisecond)
}

func TestRunExpiredSessionWithStorageKeys(t *testing.T) {
	// Exercise the fileSets loop in Run() — expired sessions with clip storage keys.
	dir := t.TempDir()
	uploadsDir := filepath.Join(dir, "uploads")
	metaStore := store.New(24)
	blobStore := storage.New(uploadsDir)
	runner := New(metaStore, blobStore, log.New(io.Discard, "", 0))

	session, err := metaStore.CreateSession()
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	// Create session upload directory with files.
	sessionDir := filepath.Join(uploadsDir, "1")
	if err := os.MkdirAll(sessionDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	for _, name := range []string{"clip1.bin", "clip2.bin"} {
		if err := os.WriteFile(filepath.Join(sessionDir, name), []byte("data"), 0o600); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
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

	// Directory should be removed.
	if _, err := os.Stat(sessionDir); !os.IsNotExist(err) {
		t.Fatalf("expected session directory to be removed, err=%v", err)
	}
}

func TestStartLogsCleanupErrors(t *testing.T) {
	// Exercise the removed > 0 log line in Start.
	dir := t.TempDir()
	uploadsDir := filepath.Join(dir, "uploads")
	metaStore := store.New(24)
	blobStore := storage.New(uploadsDir)

	// Use a channel-based writer to avoid data races on the log buffer.
	logCh := make(chan string, 10)
	logWriter := &chanWriter{ch: logCh}
	runner := New(metaStore, blobStore, log.New(logWriter, "", 0))

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
