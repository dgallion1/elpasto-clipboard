package store

import (
	"bytes"
	"context"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// syncBuffer is a thread-safe bytes.Buffer for capturing log output in tests.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (sb *syncBuffer) Write(p []byte) (int, error) {
	sb.mu.Lock()
	defer sb.mu.Unlock()
	return sb.buf.Write(p)
}

func (sb *syncBuffer) String() string {
	sb.mu.Lock()
	defer sb.mu.Unlock()
	return sb.buf.String()
}

func (sb *syncBuffer) Reset() {
	sb.mu.Lock()
	defer sb.mu.Unlock()
	sb.buf.Reset()
}

func (sb *syncBuffer) Len() int {
	sb.mu.Lock()
	defer sb.mu.Unlock()
	return sb.buf.Len()
}

func TestSnapshotRoundTrip(t *testing.T) {
	s := New(24)
	s.now = func() time.Time { return time.Date(2026, 3, 9, 12, 0, 0, 0, time.UTC) }

	// Create two sessions with clips.
	sess1, err := s.CreateSession()
	if err != nil {
		t.Fatal(err)
	}
	sess2, err := s.CreateSession()
	if err != nil {
		t.Fatal(err)
	}

	// Save snapshot.
	dir := t.TempDir()
	path := filepath.Join(dir, "snapshot.json")
	if err := s.SaveSnapshot(path); err != nil {
		t.Fatal(err)
	}

	// Verify file exists and has restrictive permissions.
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0600 {
		t.Errorf("expected permissions 0600, got %o", perm)
	}

	// Restore into a fresh store.
	s2 := New(24)
	s2.now = s.now
	sessions, clips, err := s2.RestoreSnapshot(path)
	if err != nil {
		t.Fatal(err)
	}
	if sessions != 2 {
		t.Errorf("expected 2 restored sessions, got %d", sessions)
	}
	if clips != 0 {
		t.Errorf("expected 0 restored clips, got %d", clips)
	}

	// Snapshot file should be deleted after restore.
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Error("expected snapshot file to be deleted after restore")
	}

	// Verify sessions are accessible.
	restored1 := s2.GetSessionByToken(sess1.Token)
	if restored1 == nil {
		t.Fatal("session 1 not found after restore")
	}
	if restored1.ID != sess1.ID {
		t.Errorf("expected session ID %d, got %d", sess1.ID, restored1.ID)
	}

	restored2 := s2.GetSessionByToken(sess2.Token)
	if restored2 == nil {
		t.Fatal("session 2 not found after restore")
	}

	// Verify new IDs don't collide with restored ones.
	sess3, err := s2.CreateSession()
	if err != nil {
		t.Fatal(err)
	}
	if sess3.ID <= sess2.ID {
		t.Errorf("new session ID %d should be greater than restored ID %d", sess3.ID, sess2.ID)
	}
}

func TestSnapshotExtendsExpiredSessions(t *testing.T) {
	s := New(1) // 1 hour expiry
	now := time.Date(2026, 3, 9, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }

	sess, err := s.CreateSession()
	if err != nil {
		t.Fatal(err)
	}

	// Save snapshot.
	dir := t.TempDir()
	path := filepath.Join(dir, "snapshot.json")
	if err := s.SaveSnapshot(path); err != nil {
		t.Fatal(err)
	}

	// Restore 2 hours later — session's original expiry has passed, but it
	// should be extended to the current config's expiry window.
	restoreTime := now.Add(2 * time.Hour)
	s2 := New(1)
	s2.now = func() time.Time { return restoreTime }
	sessions, _, err := s2.RestoreSnapshot(path)
	if err != nil {
		t.Fatal(err)
	}
	if sessions != 1 {
		t.Errorf("expected 1 restored session (extended), got %d", sessions)
	}
	restored := s2.GetSessionByToken(sess.Token)
	if restored == nil {
		t.Fatal("expired session should be restored with extended expiry")
	}
	if s2.IsExpired(*restored) {
		t.Error("restored session should not be expired after extension")
	}
}

func TestRestoreSnapshotNoFile(t *testing.T) {
	s := New(24)
	sessions, clips, err := s.RestoreSnapshot("/nonexistent/path/snapshot.json")
	if err != nil {
		t.Fatal("expected no error for missing file")
	}
	if sessions != 0 || clips != 0 {
		t.Error("expected 0 sessions and 0 clips for missing file")
	}
}

func TestSnapshotLoopSavesOnMutation(t *testing.T) {
	s := New(24)
	s.now = func() time.Time { return time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC) }

	dir := t.TempDir()
	path := filepath.Join(dir, "snapshot.json")
	var logBuf syncBuffer
	logger := log.New(&logBuf, "", 0)

	ctx, cancel := context.WithCancel(context.Background())

	// Start loop with a very short interval.
	done := s.StartSnapshotLoop(ctx, path, 10*time.Millisecond, logger)

	// No mutation yet — snapshot should not be written.
	time.Sleep(30 * time.Millisecond)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("snapshot should not exist when store is clean")
	}

	// Create a session (marks dirty).
	if _, err := s.CreateSession(); err != nil {
		t.Fatal(err)
	}

	// Wait for periodic tick to pick it up.
	time.Sleep(30 * time.Millisecond)
	if _, err := os.Stat(path); os.IsNotExist(err) {
		t.Fatal("snapshot should exist after mutation + tick")
	}
	if !strings.Contains(logBuf.String(), "periodic: saved session snapshot") {
		t.Fatalf("expected periodic save log, got %q", logBuf.String())
	}

	// Remove file, create another session, cancel context — should save on shutdown.
	os.Remove(path)
	logBuf.Reset()
	if _, err := s.CreateSession(); err != nil {
		t.Fatal(err)
	}
	cancel()
	<-done // wait for shutdown save to complete

	if _, err := os.Stat(path); os.IsNotExist(err) {
		t.Fatal("snapshot should exist after shutdown save")
	}
	if !strings.Contains(logBuf.String(), "shutdown: saved session snapshot") {
		t.Fatalf("expected shutdown save log, got %q", logBuf.String())
	}
}

func TestRestoreMarksDirtySoSecondRestartSurvives(t *testing.T) {
	s := New(24)
	now := time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }

	// Create a session and save a snapshot.
	if _, err := s.CreateSession(); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "snapshot.json")
	if err := s.SaveSnapshot(path); err != nil {
		t.Fatal(err)
	}

	// Restore into a new store — no further mutations.
	s2 := New(24)
	s2.now = s.now
	sessions, _, err := s2.RestoreSnapshot(path)
	if err != nil {
		t.Fatal(err)
	}
	if sessions != 1 {
		t.Fatalf("expected 1 restored session, got %d", sessions)
	}

	// The store should be dirty after restore so the snapshot loop
	// re-persists the data. Without this, a second restart would find
	// no snapshot file and lose sessions.
	var logBuf syncBuffer
	logger := log.New(&logBuf, "", 0)
	ctx, cancel := context.WithCancel(context.Background())
	done := s2.StartSnapshotLoop(ctx, path, 10*time.Millisecond, logger)

	time.Sleep(30 * time.Millisecond)
	cancel()
	<-done

	if _, err := os.Stat(path); os.IsNotExist(err) {
		t.Fatal("snapshot should be re-written after restore without mutations")
	}
}

func TestSnapshotLoopSkipsCleanStore(t *testing.T) {
	s := New(24)
	s.now = func() time.Time { return time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC) }

	dir := t.TempDir()
	path := filepath.Join(dir, "snapshot.json")
	var logBuf syncBuffer
	logger := log.New(&logBuf, "", 0)

	ctx, cancel := context.WithCancel(context.Background())
	done := s.StartSnapshotLoop(ctx, path, 10*time.Millisecond, logger)

	// Let a few ticks pass with no mutations.
	time.Sleep(50 * time.Millisecond)
	cancel()
	<-done

	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("snapshot should not be written for a clean store")
	}
	if logBuf.Len() > 0 {
		t.Fatalf("expected no log output, got %q", logBuf.String())
	}
}

func TestMarkDirty(t *testing.T) {
	s := New(24)
	// Initially not dirty — saveIfDirty should be a no-op.
	dir := t.TempDir()
	path := filepath.Join(dir, "snapshot.json")
	var logBuf syncBuffer
	logger := log.New(&logBuf, "", 0)

	s.saveIfDirty(path, logger, "test")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("saveIfDirty on clean store should not write a file")
	}

	// After MarkDirty, saveIfDirty should save.
	s.MarkDirty()
	s.saveIfDirty(path, logger, "test")
	if _, err := os.Stat(path); os.IsNotExist(err) {
		t.Fatal("saveIfDirty on dirty store should write a file")
	}
	if !strings.Contains(logBuf.String(), "test: saved session snapshot") {
		t.Fatalf("expected save log, got %q", logBuf.String())
	}
}

func TestSaveIfDirtyWriteError(t *testing.T) {
	s := New(24)
	s.now = func() time.Time { return time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC) }
	s.MarkDirty()

	// Use a path that cannot be written to (nonexistent directory).
	badPath := "/nonexistent-dir-xyz/snapshot.json"
	var logBuf syncBuffer
	logger := log.New(&logBuf, "", 0)

	s.saveIfDirty(badPath, logger, "fail-test")

	if !strings.Contains(logBuf.String(), "fail-test snapshot save failed") {
		t.Fatalf("expected failure log, got %q", logBuf.String())
	}
	// dirty flag should be re-set for retry.
	if !s.dirty.Load() {
		t.Fatal("dirty flag should be re-set after failed save")
	}
}

func TestSaveSnapshotEmptyStore(t *testing.T) {
	s := New(24)
	s.now = func() time.Time { return time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC) }

	dir := t.TempDir()
	path := filepath.Join(dir, "snapshot.json")
	if err := s.SaveSnapshot(path); err != nil {
		t.Fatalf("SaveSnapshot on empty store: %v", err)
	}

	// Restore from the empty snapshot.
	s2 := New(24)
	s2.now = s.now
	sessions, clips, err := s2.RestoreSnapshot(path)
	if err != nil {
		t.Fatalf("RestoreSnapshot: %v", err)
	}
	if sessions != 0 || clips != 0 {
		t.Fatalf("expected 0 sessions and 0 clips from empty snapshot, got %d/%d", sessions, clips)
	}
}

func TestSaveSnapshotWriteError(t *testing.T) {
	s := New(24)
	s.now = func() time.Time { return time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC) }

	err := s.SaveSnapshot("/nonexistent-dir-xyz/snapshot.json")
	if err == nil {
		t.Fatal("expected error writing to bad path")
	}
	if !strings.Contains(err.Error(), "write snapshot") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRestoreSnapshotCorruptJSON(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "snapshot.json")
	if err := os.WriteFile(path, []byte("not valid json{{{"), 0600); err != nil {
		t.Fatal(err)
	}

	s := New(24)
	_, _, err := s.RestoreSnapshot(path)
	if err == nil {
		t.Fatal("expected error for corrupt JSON")
	}
	if !strings.Contains(err.Error(), "unmarshal snapshot") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRestoreSnapshotBadVersion(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "snapshot.json")
	data := `{"version":999,"saved_at":"2026-03-15T12:00:00Z","next_session_id":1,"sessions":[]}`
	if err := os.WriteFile(path, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}

	s := New(24)
	_, _, err := s.RestoreSnapshot(path)
	if err == nil {
		t.Fatal("expected error for unsupported version")
	}
	if !strings.Contains(err.Error(), "unsupported snapshot version") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRestoreSnapshotBadSessionTimestamps(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "snapshot.json")

	// Bad ExpiresAt — should be skipped.
	data := `{"version":1,"saved_at":"2026-03-15T12:00:00Z","next_session_id":2,"sessions":[` +
		`{"id":1,"token":"alpha-bravo-charlie-delta-echo","created_at":"2026-03-15T12:00:00Z","expires_at":"not-a-time"}` +
		`]}`
	if err := os.WriteFile(path, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}

	s := New(24)
	s.now = func() time.Time { return time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC) }
	sessions, _, err := s.RestoreSnapshot(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sessions != 0 {
		t.Fatalf("expected 0 sessions (bad expires_at skipped), got %d", sessions)
	}

	// Bad CreatedAt — should be skipped.
	path2 := filepath.Join(dir, "snapshot2.json")
	data2 := `{"version":1,"saved_at":"2026-03-15T12:00:00Z","next_session_id":2,"sessions":[` +
		`{"id":1,"token":"alpha-bravo-charlie-delta-echo","created_at":"not-a-time","expires_at":"2026-03-16T12:00:00Z"}` +
		`]}`
	if err := os.WriteFile(path2, []byte(data2), 0600); err != nil {
		t.Fatal(err)
	}

	s2 := New(24)
	s2.now = func() time.Time { return time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC) }
	sessions2, _, err := s2.RestoreSnapshot(path2)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sessions2 != 0 {
		t.Fatalf("expected 0 sessions (bad created_at skipped), got %d", sessions2)
	}
}

func TestRestoreSnapshotNoSessionsRestoredNotDirty(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "snapshot.json")

	// All sessions have bad timestamps — none will be restored.
	data := `{"version":1,"saved_at":"2026-03-15T12:00:00Z","next_session_id":2,"sessions":[` +
		`{"id":1,"token":"alpha-bravo-charlie-delta-echo","created_at":"bad","expires_at":"bad"}` +
		`]}`
	if err := os.WriteFile(path, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}

	s := New(24)
	s.now = func() time.Time { return time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC) }
	sessions, _, err := s.RestoreSnapshot(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sessions != 0 {
		t.Fatalf("expected 0 sessions, got %d", sessions)
	}
	// dirty flag should NOT be set when no sessions were restored.
	if s.dirty.Load() {
		t.Fatal("dirty flag should not be set when no sessions were restored")
	}
}

func TestRestoreSnapshotReadError(t *testing.T) {
	// Create a path that exists but can't be read (directory, not file).
	dir := t.TempDir()
	path := filepath.Join(dir, "subdir")
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}

	s := New(24)
	_, _, err := s.RestoreSnapshot(path)
	if err == nil {
		t.Fatal("expected error when reading a directory as snapshot")
	}
	if !strings.Contains(err.Error(), "read snapshot") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRestoreSnapshotLowerNextSessionID(t *testing.T) {
	// If snapshot has a lower next_session_id than current, it should NOT overwrite.
	dir := t.TempDir()
	path := filepath.Join(dir, "snapshot.json")

	data := `{"version":1,"saved_at":"2026-03-15T12:00:00Z","next_session_id":2,"sessions":[` +
		`{"id":1,"token":"alpha-bravo-charlie-delta-echo","created_at":"2026-03-15T12:00:00Z","expires_at":"2026-03-16T12:00:00Z"}` +
		`]}`
	if err := os.WriteFile(path, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}

	s := New(24)
	s.now = func() time.Time { return time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC) }
	// Pre-advance the ID counter past the snapshot value.
	s.nextSessionID.Store(100)

	_, _, err := s.RestoreSnapshot(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// nextSessionID should NOT have been lowered.
	if s.nextSessionID.Load() != 100 {
		t.Fatalf("nextSessionID = %d, want 100 (should not be lowered)", s.nextSessionID.Load())
	}
}

func TestSaveSnapshotExtendsShortExpiry(t *testing.T) {
	// Session created with a very short expiry should be extended during save.
	s := New(24) // 24 hour expiry
	now := time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }

	sess, err := s.CreateSession()
	if err != nil {
		t.Fatal(err)
	}

	// Set expiry to only 1 hour from now (less than 24h config).
	s.SetSessionExpiry(sess.ID, now.Add(1*time.Hour))

	dir := t.TempDir()
	path := filepath.Join(dir, "snapshot.json")
	if err := s.SaveSnapshot(path); err != nil {
		t.Fatal(err)
	}

	// Restore and verify the session's expiry was extended to 24h.
	s2 := New(24)
	s2.now = func() time.Time { return now }
	sessions, _, err := s2.RestoreSnapshot(path)
	if err != nil {
		t.Fatal(err)
	}
	if sessions != 1 {
		t.Fatalf("expected 1 session, got %d", sessions)
	}

	restored := s2.GetSessionByToken(sess.Token)
	if restored == nil {
		t.Fatal("session not found after restore")
	}
}

func TestRestoreSnapshotAdvancesNextSessionID(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "snapshot.json")

	data := `{"version":1,"saved_at":"2026-03-15T12:00:00Z","next_session_id":42,"sessions":[` +
		`{"id":1,"token":"alpha-bravo-charlie-delta-echo","created_at":"2026-03-15T12:00:00Z","expires_at":"2026-03-16T12:00:00Z"}` +
		`]}`
	if err := os.WriteFile(path, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}

	s := New(24)
	s.now = func() time.Time { return time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC) }
	_, _, err := s.RestoreSnapshot(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// New session should have ID > 42.
	sess, err := s.CreateSession()
	if err != nil {
		t.Fatal(err)
	}
	if sess.ID <= 42 {
		t.Fatalf("expected session ID > 42, got %d", sess.ID)
	}
}

