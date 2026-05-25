package storage

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type Store struct {
	uploadsDir string
}

func New(uploadsDir string) *Store {
	return &Store{uploadsDir: uploadsDir}
}

func (s *Store) filePath(sessionID int64, storageKey string) (string, bool) {
	if !validStorageKey(s.sessionDir(sessionID), storageKey) {
		return "", false
	}
	return filepath.Join(s.sessionDir(sessionID), storageKey), true
}

func validStorageKey(dir string, storageKey string) bool {
	if storageKey == "" || storageKey == "." || storageKey == ".." {
		return false
	}
	if strings.Contains(storageKey, "/") || strings.Contains(storageKey, "\\") || strings.ContainsRune(storageKey, '\x00') {
		return false
	}

	resolved := filepath.Clean(filepath.Join(dir, storageKey))
	if resolved != dir && !strings.HasPrefix(resolved, dir+string(os.PathSeparator)) {
		return false
	}

	return true
}

func (s *Store) DeleteFile(sessionID int64, storageKey string) {
	filePath, ok := s.filePath(sessionID, storageKey)
	if !ok {
		return
	}
	_ = os.Remove(filePath)
}

func (s *Store) DeleteSessionFiles(sessionID int64) {
	_ = os.RemoveAll(s.sessionDir(sessionID))
}

// SweepOrphanedUploads removes upload directories that do not belong to an active session.
// Tolerates a missing uploads directory.
func (s *Store) SweepOrphanedUploads(activeSessionIDs []int64) (int, error) {
	entries, err := os.ReadDir(s.uploadsDir)
	if os.IsNotExist(err) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}

	keep := make(map[string]struct{}, len(activeSessionIDs))
	for _, sessionID := range activeSessionIDs {
		keep[fmt.Sprintf("%d", sessionID)] = struct{}{}
	}

	removed := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if _, ok := keep[entry.Name()]; ok {
			continue
		}
		if err := os.RemoveAll(filepath.Join(s.uploadsDir, entry.Name())); err != nil {
			return removed, err
		}
		removed++
	}
	return removed, nil
}

func (s *Store) sessionDir(sessionID int64) string {
	return filepath.Join(s.uploadsDir, fmt.Sprintf("%d", sessionID))
}
