package storage

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSweepOrphanedUploadsRemovesAllWithoutActiveSessions(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)

	for _, name := range []string{"1", "2", "42"} {
		sessionDir := filepath.Join(dir, name)
		if err := os.MkdirAll(sessionDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(sessionDir, "file.bin"), []byte("data"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	removed, err := s.SweepOrphanedUploads(nil)
	if err != nil {
		t.Fatalf("SweepOrphanedUploads: %v", err)
	}
	if removed != 3 {
		t.Errorf("removed = %d, want 3", removed)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Errorf("expected empty dir, got %d entries", len(entries))
	}
}

func TestSweepOrphanedUploadsMissingDir(t *testing.T) {
	s := New(filepath.Join(t.TempDir(), "nonexistent"))
	removed, err := s.SweepOrphanedUploads(nil)
	if err != nil {
		t.Fatalf("SweepOrphanedUploads: %v", err)
	}
	if removed != 0 {
		t.Errorf("removed = %d, want 0", removed)
	}
}

func TestSweepOrphanedUploadsIgnoresFiles(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)

	if err := os.WriteFile(filepath.Join(dir, "stray-file.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	removed, err := s.SweepOrphanedUploads(nil)
	if err != nil {
		t.Fatalf("SweepOrphanedUploads: %v", err)
	}
	if removed != 0 {
		t.Errorf("removed = %d, want 0", removed)
	}

	if _, err := os.Stat(filepath.Join(dir, "stray-file.txt")); err != nil {
		t.Error("stray file should not have been removed")
	}
}

func TestSweepOrphanedUploadsPreservesActiveSessionDirs(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)

	for _, name := range []string{"1", "2", "99"} {
		sessionDir := filepath.Join(dir, name)
		if err := os.MkdirAll(sessionDir, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	removed, err := s.SweepOrphanedUploads([]int64{2, 99})
	if err != nil {
		t.Fatalf("SweepOrphanedUploads: %v", err)
	}
	if removed != 1 {
		t.Fatalf("removed = %d, want 1", removed)
	}

	if _, err := os.Stat(filepath.Join(dir, "1")); !os.IsNotExist(err) {
		t.Fatalf("expected orphaned session dir 1 to be removed, err=%v", err)
	}
	for _, kept := range []string{"2", "99"} {
		if _, err := os.Stat(filepath.Join(dir, kept)); err != nil {
			t.Fatalf("expected session dir %s to be preserved: %v", kept, err)
		}
	}
}

func TestDeleteFileRemovesMatchingFile(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)

	sessionDir := filepath.Join(dir, "7")
	if err := os.MkdirAll(sessionDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	path := filepath.Join(sessionDir, "photo.png")
	if err := os.WriteFile(path, []byte("hello"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	s.DeleteFile(7, "photo.png")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("expected file to be deleted, got err=%v", err)
	}
}

func TestDeleteFileIgnoresInvalidKey(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)

	sessionDir := filepath.Join(dir, "7")
	if err := os.MkdirAll(sessionDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	neighbor := filepath.Join(dir, "neighbor.txt")
	if err := os.WriteFile(neighbor, []byte("hello"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	s.DeleteFile(7, "../neighbor.txt")

	body, err := os.ReadFile(neighbor)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(body) != "hello" {
		t.Fatalf("unexpected neighbor contents %q", body)
	}
}

func TestValidStorageKeyEdgeCases(t *testing.T) {
	dir := "/some/dir"
	tests := []struct {
		name string
		key  string
		want bool
	}{
		{"empty key", "", false},
		{"dot", ".", false},
		{"dotdot", "..", false},
		{"forward slash", "a/b", false},
		{"backslash", "a\\b", false},
		{"null byte", "a\x00b", false},
		{"valid simple", "file.txt", true},
		{"valid uuid", "550e8400-e29b-41d4-a716-446655440000", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := validStorageKey(dir, tt.key); got != tt.want {
				t.Fatalf("validStorageKey(%q, %q) = %v, want %v", dir, tt.key, got, tt.want)
			}
		})
	}
}

func TestSweepOrphanedUploadsNoOrphans(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)

	// Create directories that all match active sessions.
	for _, name := range []string{"1", "2"} {
		if err := os.MkdirAll(filepath.Join(dir, name), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	removed, err := s.SweepOrphanedUploads([]int64{1, 2})
	if err != nil {
		t.Fatalf("SweepOrphanedUploads: %v", err)
	}
	if removed != 0 {
		t.Fatalf("removed = %d, want 0", removed)
	}

	// All directories should still exist.
	for _, name := range []string{"1", "2"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Fatalf("expected dir %s to exist: %v", name, err)
		}
	}
}

func TestDeleteSessionFiles(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)

	sessionDir := filepath.Join(dir, "5")
	if err := os.MkdirAll(sessionDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sessionDir, "data.bin"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	s.DeleteSessionFiles(5)

	if _, err := os.Stat(sessionDir); !os.IsNotExist(err) {
		t.Fatalf("expected session dir to be removed, err=%v", err)
	}
}

func TestSweepOrphanedUploadsReadDirError(t *testing.T) {
	// Create a file (not directory) where the uploads dir should be.
	dir := t.TempDir()
	fakeDir := filepath.Join(dir, "not-a-dir")
	if err := os.WriteFile(fakeDir, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	s := New(fakeDir)
	_, err := s.SweepOrphanedUploads(nil)
	if err == nil {
		t.Fatal("expected error when uploads dir is a file")
	}
}

func TestValidStorageKeyPathTraversal(t *testing.T) {
	// Test the filepath.Clean check — a key that resolves outside the session dir.
	// On some OS/path combos, this is caught by the "/" or ".." checks, but
	// we test it explicitly for the Clean/HasPrefix check.
	dir := "/some/dir"

	// These should all be caught by earlier checks (/ or ..)
	if validStorageKey(dir, "../etc/passwd") {
		t.Fatal("path traversal should be rejected")
	}

	// Null byte embedded
	if validStorageKey(dir, "file\x00name") {
		t.Fatal("null byte should be rejected")
	}
}

func TestSweepOrphanedUploadsRemoveError(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("skipping permission test as root")
	}

	dir := t.TempDir()
	s := New(dir)

	// Create a subdirectory that can't be removed (remove write permission on parent).
	subDir := filepath.Join(dir, "42")
	if err := os.MkdirAll(filepath.Join(subDir, "nested"), 0o755); err != nil {
		t.Fatal(err)
	}

	// Remove write+execute permission on the subdirectory so RemoveAll fails.
	if err := os.Chmod(subDir, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		os.Chmod(subDir, 0o755)
	})

	_, err := s.SweepOrphanedUploads(nil)
	if err == nil {
		t.Fatal("expected error when RemoveAll fails due to permissions")
	}
}

func TestDeleteFileNonexistentFile(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)

	sessionDir := filepath.Join(dir, "7")
	if err := os.MkdirAll(sessionDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// Should not panic when file doesn't exist.
	s.DeleteFile(7, "nonexistent.bin")
}
