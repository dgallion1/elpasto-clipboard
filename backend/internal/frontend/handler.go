package frontend

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"encoding/hex"
	"io/fs"
	"net/http"
	"os"
	"path"
	"strings"

	"elpasto/backend/internal/tokens"
)

const tokenPlaceholder = "__ELPASTO_TOKEN__"
const tunnelPeerPlaceholder = "__ELPASTO_TUNNEL_PEER__"
const buildVersionPath = "/__elpasto/version"

type handler struct {
	dist           fs.FS
	files          http.Handler
	buildID        string
	indexHTML      []byte
	tokenHTML      []byte
	tunnelHTML     []byte
	tunnelViewHTML []byte
	statsHTML      []byte
}

func Handler() http.Handler {
	distRoot, err := fs.Sub(distFS, "dist")
	if err != nil {
		panic("frontend: embedded dist directory missing: " + err.Error())
	}

	return newHandler(distRoot)
}

func newHandler(distRoot fs.FS) http.Handler {
	indexHTML := mustReadHTML(distRoot, "index.html", placeholderHTML)
	tokenHTML := mustReadHTML(distRoot, "token.html", indexHTML)
	tunnelHTML := mustReadHTML(distRoot, "tunnel.html", indexHTML)
	tunnelViewHTML := mustReadHTML(distRoot, "tunnel-view.html", tunnelHTML)
	statsHTML := mustReadHTML(distRoot, "stats.html", indexHTML)
	buildID := computeBuildID(indexHTML, tokenHTML)

	return &handler{
		dist:           distRoot,
		files:          http.FileServer(http.FS(distRoot)),
		buildID:        buildID,
		indexHTML:      injectBuildID(indexHTML, buildID),
		tokenHTML:      injectBuildID(tokenHTML, buildID),
		tunnelHTML:     injectBuildID(tunnelHTML, buildID),
		tunnelViewHTML: injectBuildID(tunnelViewHTML, buildID),
		statsHTML:      injectBuildID(statsHTML, buildID),
	}
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	setSecurityHeaders(w.Header())

	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.NotFound(w, r)
		return
	}

	if strings.HasPrefix(r.URL.Path, "/api/") {
		http.NotFound(w, r)
		return
	}

	if r.URL.Path == buildVersionPath {
		serveBuildVersion(w, r, h.buildID)
		return
	}

	name := cleanAssetPath(r.URL.Path)
	if name == "favicon.ico" {
		name = "icon.svg"
	}
	if name != "" && h.serveEmbeddedFile(w, r, name) {
		return
	}

	if r.URL.Path == "/" {
		serveHTML(w, r, h.indexHTML)
		return
	}

	if r.URL.Path == "/stats" || r.URL.Path == "/stats/" {
		serveHTML(w, r, h.statsHTML)
		return
	}

	if token, ok := tokenFromPath(r.URL.Path); ok {
		serveHTML(w, r, bytes.ReplaceAll(h.tokenHTML, []byte(tokenPlaceholder), escapedTokenValue(token)))
		return
	}

	if peerId, ok := tunnelPeerFromPath(r.URL.Path); ok {
		serveHTML(w, r, bytes.ReplaceAll(h.tunnelHTML, []byte(tunnelPeerPlaceholder), []byte(peerId)))
		return
	}

	if peerId, ok := tunnelViewPeerFromPath(r.URL.Path); ok {
		serveHTML(w, r, bytes.ReplaceAll(h.tunnelViewHTML, []byte(tunnelPeerPlaceholder), []byte(peerId)))
		return
	}

	http.NotFound(w, r)
}

func (h *handler) serveEmbeddedFile(w http.ResponseWriter, r *http.Request, name string) bool {
	info, err := fs.Stat(h.dist, name)
	if err != nil || info.IsDir() {
		return false
	}

	if strings.HasPrefix(name, "_next/static/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else if strings.Contains(name, "-sw") && strings.HasSuffix(name, ".js") {
		// Service workers must not be cached — browsers need the latest version.
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	}

	req := r.Clone(r.Context())
	req.URL.Path = "/" + name
	h.files.ServeHTTP(w, req)
	return true
}

func setSecurityHeaders(headers http.Header) {
	headers.Set("Content-Security-Policy", strings.Join([]string{
		"default-src 'self'",
		"script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' blob: data:",
		"connect-src 'self' ws: wss: https://cloudflareinsights.com",
		"worker-src 'self' blob:",
		"frame-ancestors 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		"font-src 'self'",
	}, "; "))
	headers.Set("X-Content-Type-Options", "nosniff")
	headers.Set("X-Frame-Options", "DENY")
	headers.Set("Referrer-Policy", "same-origin")
	headers.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")

	if os.Getenv("NODE_ENV") == "production" {
		headers.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
	}
}

func serveHTML(w http.ResponseWriter, r *http.Request, body []byte) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)

	if r.Method == http.MethodHead {
		return
	}

	_, _ = w.Write(body)
}

func serveBuildVersion(w http.ResponseWriter, r *http.Request, buildID string) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)

	if r.Method == http.MethodHead {
		return
	}

	_, _ = w.Write([]byte(buildID))
}

func mustReadHTML(root fs.FS, name string, fallback []byte) []byte {
	body, err := fs.ReadFile(root, name)
	if err != nil {
		return fallback
	}
	return body
}

func cleanAssetPath(requestPath string) string {
	cleaned := path.Clean("/" + requestPath)
	switch cleaned {
	case "/", ".":
		return ""
	}
	return strings.TrimPrefix(cleaned, "/")
}

func tokenFromPath(requestPath string) (string, bool) {
	cleaned := strings.Trim(path.Clean("/"+requestPath), "/")
	if !tokens.IsValid(cleaned) {
		return "", false
	}
	return cleaned, true
}

// tunnelViewPeerFromPath returns the peerId for paths matching /tunnel-view/{peerId}[/...].
func tunnelViewPeerFromPath(requestPath string) (string, bool) {
	return extractPeerFromPrefix(requestPath, "/tunnel-view/")
}

// tunnelPeerFromPath returns the peerId for paths matching /tunnel/{peerId}[/...].
// The peerId must be a non-empty string containing only alphanumeric chars and hyphens.
func tunnelPeerFromPath(requestPath string) (string, bool) {
	return extractPeerFromPrefix(requestPath, "/tunnel/")
}

func extractPeerFromPrefix(requestPath, prefix string) (string, bool) {
	trimmed := strings.TrimPrefix(requestPath, prefix)
	if trimmed == requestPath {
		return "", false
	}
	// Extract first path segment as peerId
	peerId := strings.SplitN(trimmed, "/", 2)[0]
	if peerId == "" {
		return "", false
	}
	// Validate: alphanumeric and hyphens only (UUIDs)
	for _, ch := range peerId {
		if !((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '-') {
			return "", false
		}
	}
	return peerId, true
}

func escapedTokenValue(token string) []byte {
	encoded, err := json.Marshal(token)
	if err != nil || len(encoded) < 2 {
		return []byte(token)
	}
	return encoded[1 : len(encoded)-1]
}

func computeBuildID(indexHTML []byte, tokenHTML []byte) string {
	sum := sha256.Sum256(append(append([]byte(nil), indexHTML...), tokenHTML...))
	return hex.EncodeToString(sum[:8])
}

func injectBuildID(body []byte, buildID string) []byte {
	snippet := []byte(`<script>window.__ELPASTO_BUILD_ID__="` + buildID + `";</script>`)

	if idx := bytes.Index(body, []byte("</head>")); idx >= 0 {
		return bytes.Join([][]byte{body[:idx], snippet, body[idx:]}, nil)
	}
	if idx := bytes.Index(body, []byte("</body>")); idx >= 0 {
		return bytes.Join([][]byte{body[:idx], snippet, body[idx:]}, nil)
	}

	return bytes.Join([][]byte{body, snippet}, nil)
}
