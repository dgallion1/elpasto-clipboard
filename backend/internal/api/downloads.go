package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var validTunnelBinary = regexp.MustCompile(`^elpasto-tunnel-(darwin|linux|windows)-(amd64|arm64)(\.exe)?$`)

type binaryInfo struct {
	OS       string `json:"os"`
	Arch     string `json:"arch"`
	Filename string `json:"filename"`
	Size     int64  `json:"size"`
}

func (s *Server) handleListDownloads(w http.ResponseWriter, _ *http.Request) {
	entries, err := os.ReadDir(s.cfg.DownloadsDir)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"binaries":[]}`))
		return
	}

	var binaries []binaryInfo
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		matches := validTunnelBinary.FindStringSubmatch(name)
		if matches == nil {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		binaries = append(binaries, binaryInfo{
			OS:       matches[1],
			Arch:     matches[2],
			Filename: name,
			Size:     info.Size(),
		})
	}

	sort.Slice(binaries, func(i, j int) bool {
		return binaries[i].Filename < binaries[j].Filename
	})

	if binaries == nil {
		binaries = []binaryInfo{}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"binaries": binaries})
}

func (s *Server) handleDownloadFile(w http.ResponseWriter, r *http.Request) {
	filename := r.PathValue("filename")

	if strings.Contains(filename, "/") || strings.Contains(filename, "\\") || strings.Contains(filename, "..") {
		http.NotFound(w, r)
		return
	}

	if !validTunnelBinary.MatchString(filename) {
		http.NotFound(w, r)
		return
	}

	path := filepath.Join(s.cfg.DownloadsDir, filename)
	f, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil || stat.IsDir() {
		http.NotFound(w, r)
		return
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	http.ServeContent(w, r, filename, stat.ModTime(), f)
}
