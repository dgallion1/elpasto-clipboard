package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type browserCommand interface {
	Start() error
}

const (
	authTimeout    = 2 * time.Minute
	tokenFilePerms = 0600
	tokenDirPerms  = 0700
	tokenFileName  = "tunnel-token"
	configDirName  = "elpasto"
)

// ensureTunnelAuthToken returns a valid tunnel auth token, using the cache or
// running the browser OAuth flow as needed.
func ensureTunnelAuthToken(ctx context.Context, serverURL string, logger *log.Logger) (string, error) {
	// Try cached token first.
	token, err := loadCachedToken()
	if err == nil && token != "" && !isTokenExpired(token) {
		logger.Printf("using cached tunnel auth token")
		return token, nil
	}

	// Run browser auth flow.
	logger.Printf("tunnel authentication required — opening browser …")
	token, err = runBrowserAuth(ctx, serverURL, logger)
	if err != nil {
		return "", fmt.Errorf("tunnel auth: %w", err)
	}

	// Cache the token.
	if err := saveCachedToken(token); err != nil {
		logger.Printf("warning: could not cache tunnel auth token: %v", err)
	}

	return token, nil
}

// tokenCachePath returns the path to the cached tunnel token.
func tokenCachePath() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(configDir, configDirName, tokenFileName), nil
}

// loadCachedToken reads the cached tunnel auth token from disk.
func loadCachedToken() (string, error) {
	path, err := tokenCachePath()
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}

// saveCachedToken writes the tunnel auth token to disk.
func saveCachedToken(token string) error {
	path, err := tokenCachePath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), tokenDirPerms); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(token), tokenFilePerms)
}

// deleteCachedToken removes the cached tunnel auth token.
func deleteCachedToken() {
	path, err := tokenCachePath()
	if err != nil {
		return
	}
	os.Remove(path)
}

// isTokenExpired checks if an ept_ token's exp claim is in the past.
// This is a local cache hint; the server is the source of truth.
func isTokenExpired(token string) bool {
	if !strings.HasPrefix(token, "ept_") {
		return true
	}
	raw := token[4:]
	parts := strings.SplitN(raw, ".", 2)
	if len(parts) != 2 {
		return true
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return true
	}
	var claims struct {
		Exp int64 `json:"exp"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return true
	}
	return time.Now().Unix() > claims.Exp
}

// runBrowserAuth starts a local HTTP server, opens the browser to the OAuth
// start endpoint, and waits for the callback with the token.
func runBrowserAuth(ctx context.Context, serverURL string, logger *log.Logger) (string, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", fmt.Errorf("listen: %w", err)
	}
	defer ln.Close()

	port := ln.Addr().(*net.TCPAddr).Port

	type result struct {
		token string
		err   error
	}
	resultCh := make(chan result, 1)

	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		if errParam := r.URL.Query().Get("error"); errParam != "" {
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprintf(w, "<html><body><h2>Authentication failed</h2><p>%s</p><p>You can close this window.</p></body></html>", html.EscapeString(errParam))
			resultCh <- result{err: fmt.Errorf("auth error: %s", errParam)}
			return
		}
		token := r.URL.Query().Get("token")
		if token == "" {
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprint(w, "<html><body><h2>Authentication failed</h2><p>No token received.</p><p>You can close this window.</p></body></html>")
			resultCh <- result{err: fmt.Errorf("no token in callback")}
			return
		}
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, "<html><body><h2>Authenticated!</h2><p>You can close this window and return to the terminal.</p></body></html>")
		resultCh <- result{token: token}
	})

	srv := &http.Server{Handler: mux}
	go srv.Serve(ln)
	defer srv.Close()

	// Build the auth start URL.
	authURL := fmt.Sprintf("%s/api/auth/tunnel/start?port=%d", strings.TrimRight(serverURL, "/"), port)

	// Try to open the browser.
	if err := openBrowserFunc(authURL); err != nil {
		logger.Printf("could not open browser: %v", err)
	}
	logger.Printf("if the browser didn't open, visit:\n  %s", authURL)

	// Wait for callback or timeout.
	authCtx, cancel := context.WithTimeout(ctx, authTimeout)
	defer cancel()

	select {
	case res := <-resultCh:
		if res.err != nil {
			return "", res.err
		}
		return res.token, nil
	case <-authCtx.Done():
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", fmt.Errorf("authentication timed out after %s", authTimeout)
	}
}

// openBrowserFunc is the function used to open a URL in the default browser.
// Tests replace this to avoid launching real browser windows.
var openBrowserFunc = openBrowser

var newBrowserCommand = func(name string, args ...string) browserCommand {
	return exec.Command(name, args...)
}

func openBrowserCommandSpec(goos, url string) (string, []string, error) {
	switch goos {
	case "darwin":
		return "open", []string{url}, nil
	case "linux":
		return "xdg-open", []string{url}, nil
	case "windows":
		return "cmd", []string{"/c", "start", url}, nil
	default:
		return "", nil, fmt.Errorf("unsupported platform: %s", goos)
	}
}

// openBrowser opens a URL in the default browser.
func openBrowser(url string) error {
	name, args, err := openBrowserCommandSpec(runtime.GOOS, url)
	if err != nil {
		return err
	}
	return newBrowserCommand(name, args...).Start()
}
