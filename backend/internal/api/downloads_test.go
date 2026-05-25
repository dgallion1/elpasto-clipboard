package api

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"elpasto/backend/internal/config"
)

func TestHandleListDownloads(t *testing.T) {
	dir := t.TempDir()

	// Create valid binaries
	for _, name := range []string{
		"elpasto-tunnel-darwin-arm64",
		"elpasto-tunnel-linux-amd64",
		"elpasto-tunnel-windows-amd64.exe",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("binary"), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}

	// Create files that should be ignored
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("readme"), 0o644); err != nil {
		t.Fatalf("write README: %v", err)
	}
	if err := os.Mkdir(filepath.Join(dir, "subdir"), 0o755); err != nil {
		t.Fatalf("mkdir subdir: %v", err)
	}

	_, serverURL := newTestServer(t, func(cfg *config.Config) {
		cfg.DownloadsDir = dir
	})

	resp, err := http.Get(serverURL + "/api/downloads/")
	if err != nil {
		t.Fatalf("GET /api/downloads/: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	var body struct {
		Binaries []binaryInfo `json:"binaries"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}

	if len(body.Binaries) != 3 {
		t.Fatalf("expected 3 binaries, got %d: %+v", len(body.Binaries), body.Binaries)
	}

	// Verify sorted order
	if body.Binaries[0].Filename != "elpasto-tunnel-darwin-arm64" {
		t.Fatalf("first binary = %q", body.Binaries[0].Filename)
	}
	if body.Binaries[0].OS != "darwin" || body.Binaries[0].Arch != "arm64" {
		t.Fatalf("first binary fields: os=%q arch=%q", body.Binaries[0].OS, body.Binaries[0].Arch)
	}
}

func TestHandleListDownloadsEmptyDir(t *testing.T) {
	dir := t.TempDir()

	_, serverURL := newTestServer(t, func(cfg *config.Config) {
		cfg.DownloadsDir = dir
	})

	resp, err := http.Get(serverURL + "/api/downloads/")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	raw, _ := io.ReadAll(resp.Body)
	var body struct {
		Binaries []binaryInfo `json:"binaries"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Binaries) != 0 {
		t.Fatalf("expected empty binaries, got %d", len(body.Binaries))
	}
}

func TestHandleDownloadFile(t *testing.T) {
	dir := t.TempDir()
	content := []byte("tunnel-binary-content")
	filename := "elpasto-tunnel-linux-amd64"
	if err := os.WriteFile(filepath.Join(dir, filename), content, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	_, serverURL := newTestServer(t, func(cfg *config.Config) {
		cfg.DownloadsDir = dir
	})

	t.Run("valid binary returns 200", func(t *testing.T) {
		resp, err := http.Get(serverURL + "/api/downloads/" + filename)
		if err != nil {
			t.Fatalf("GET: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			t.Fatalf("expected 200, got %d", resp.StatusCode)
		}
	})

	t.Run("Content-Type is application/octet-stream", func(t *testing.T) {
		resp, err := http.Get(serverURL + "/api/downloads/" + filename)
		if err != nil {
			t.Fatalf("GET: %v", err)
		}
		defer resp.Body.Close()

		ct := resp.Header.Get("Content-Type")
		if ct != "application/octet-stream" {
			t.Fatalf("Content-Type = %q", ct)
		}
	})

	t.Run("Content-Disposition includes filename", func(t *testing.T) {
		resp, err := http.Get(serverURL + "/api/downloads/" + filename)
		if err != nil {
			t.Fatalf("GET: %v", err)
		}
		defer resp.Body.Close()

		cd := resp.Header.Get("Content-Disposition")
		if cd != `attachment; filename="elpasto-tunnel-linux-amd64"` {
			t.Fatalf("Content-Disposition = %q", cd)
		}
	})

	t.Run("body matches file contents", func(t *testing.T) {
		resp, err := http.Get(serverURL + "/api/downloads/" + filename)
		if err != nil {
			t.Fatalf("GET: %v", err)
		}
		defer resp.Body.Close()

		body, _ := io.ReadAll(resp.Body)
		if string(body) != string(content) {
			t.Fatalf("body = %q", body)
		}
	})

	t.Run("missing file returns 404", func(t *testing.T) {
		resp, err := http.Get(serverURL + "/api/downloads/elpasto-tunnel-darwin-arm64")
		if err != nil {
			t.Fatalf("GET: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("expected 404, got %d", resp.StatusCode)
		}
	})

	t.Run("invalid filename pattern returns 404", func(t *testing.T) {
		resp, err := http.Get(serverURL + "/api/downloads/not-a-tunnel-binary")
		if err != nil {
			t.Fatalf("GET: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("expected 404, got %d", resp.StatusCode)
		}
	})

	t.Run("encoded traversal-like filename returns 404", func(t *testing.T) {
		resp, err := http.Get(serverURL + "/api/downloads/..%2F..%2Fetc%2Fpasswd")
		if err != nil {
			t.Fatalf("GET: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("expected 404, got %d", resp.StatusCode)
		}
	})
}
