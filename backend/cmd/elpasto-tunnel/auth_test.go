package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

type stubBrowserCommand struct {
	started bool
	err     error
}

func (c *stubBrowserCommand) Start() error {
	c.started = true
	return c.err
}

func TestIsTokenExpired(t *testing.T) {
	// Valid-looking token with exp far in the future.
	// {"sub":"1","email":"a@b.com","exp":9999999999}
	// base64url: eyJzdWIiOiIxIiwiZW1haWwiOiJhQGIuY29tIiwiZXhwIjo5OTk5OTk5OTk5fQ
	notExpired := "ept_eyJzdWIiOiIxIiwiZW1haWwiOiJhQGIuY29tIiwiZXhwIjo5OTk5OTk5OTk5fQ.fakesig"
	if isTokenExpired(notExpired) {
		t.Fatal("token with far-future exp should not be expired")
	}

	// Token with exp in the past.
	// {"sub":"1","email":"a@b.com","exp":1}
	// base64url: eyJzdWIiOiIxIiwiZW1haWwiOiJhQGIuY29tIiwiZXhwIjoxfQ
	expired := "ept_eyJzdWIiOiIxIiwiZW1haWwiOiJhQGIuY29tIiwiZXhwIjoxfQ.fakesig"
	if !isTokenExpired(expired) {
		t.Fatal("token with exp=1 should be expired")
	}
}

func TestIsTokenExpiredMalformed(t *testing.T) {
	cases := []string{"", "not-a-token", "ept_", "ept_abc", "ept_!!!.sig"}
	for _, tc := range cases {
		if !isTokenExpired(tc) {
			t.Errorf("malformed token %q should be treated as expired", tc)
		}
	}
}

func TestIsTokenExpired_InvalidBase64(t *testing.T) {
	// ept_ prefix present, has a dot, but payload is not valid base64.
	if !isTokenExpired("ept_!!!invalid-base64!!!.sig") {
		t.Fatal("token with invalid base64 should be treated as expired")
	}
}

func TestIsTokenExpired_InvalidJSON(t *testing.T) {
	// Valid base64 but not valid JSON.
	// base64url("not json") = bm90IGpzb24
	if !isTokenExpired("ept_bm90IGpzb24.sig") {
		t.Fatal("token with invalid JSON should be treated as expired")
	}
}

func TestTokenCacheRoundTrip(t *testing.T) {
	// Override config dir to a temp directory.
	tmp := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", tmp)

	token := "ept_test-payload.test-sig"
	if err := saveCachedToken(token); err != nil {
		t.Fatalf("save: %v", err)
	}

	loaded, err := loadCachedToken()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if loaded != token {
		t.Fatalf("loaded = %q, want %q", loaded, token)
	}

	// Check file permissions.
	path := filepath.Join(tmp, configDirName, tokenFileName)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm() != tokenFilePerms {
		t.Fatalf("perm = %o, want %o", info.Mode().Perm(), tokenFilePerms)
	}

	// Delete and verify it's gone.
	deleteCachedToken()
	_, err = loadCachedToken()
	if err == nil {
		t.Fatal("expected error after delete")
	}
}

func TestEnsureTunnelAuthToken_CachedUnexpiredReused(t *testing.T) {
	// Verify that a valid cached token is returned without running the browser flow.
	tmp := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", tmp)

	// Cache a token with exp far in the future.
	cachedToken := "ept_eyJzdWIiOiIxIiwiZW1haWwiOiJhQGIuY29tIiwiZXhwIjo5OTk5OTk5OTk5fQ.fakesig"
	if err := saveCachedToken(cachedToken); err != nil {
		t.Fatalf("save: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	logger := log.New(log.Writer(), "test: ", 0)

	// ensureTunnelAuthToken should return the cached token immediately.
	// If it tries to run the browser flow, it will block until the context
	// times out (since no server is running), causing a test failure.
	got, err := ensureTunnelAuthToken(ctx, "http://127.0.0.1:1", logger)
	if err != nil {
		t.Fatalf("ensureTunnelAuthToken: %v", err)
	}
	if got != cachedToken {
		t.Fatalf("got %q, want cached token", got)
	}
}

func TestEnsureTunnelAuthToken_ExpiredCacheNotReused(t *testing.T) {
	openBrowserFunc = func(string) error { return nil }
	t.Cleanup(func() { openBrowserFunc = openBrowser })

	tmp := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", tmp)

	// Cache a token with exp=1 (1970, long expired).
	expiredToken := "ept_eyJzdWIiOiIxIiwiZW1haWwiOiJhQGIuY29tIiwiZXhwIjoxfQ.fakesig"
	if err := saveCachedToken(expiredToken); err != nil {
		t.Fatalf("save: %v", err)
	}

	// Use a very short timeout — the browser flow will fail quickly.
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	logger := log.New(log.Writer(), "test: ", 0)

	_, err := ensureTunnelAuthToken(ctx, "http://127.0.0.1:1", logger)
	if err == nil {
		t.Fatal("expected error for expired cache (browser flow should timeout)")
	}
}

func TestEnsureTunnelAuthToken_NoCacheRunsBrowserFlow(t *testing.T) {
	openBrowserFunc = func(string) error { return nil }
	t.Cleanup(func() { openBrowserFunc = openBrowser })

	tmp := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", tmp)

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	logger := log.New(log.Writer(), "test: ", 0)

	_, err := ensureTunnelAuthToken(ctx, "http://127.0.0.1:1", logger)
	if err == nil {
		t.Fatal("expected error when no cache and browser flow times out")
	}
}

func TestSaveCachedToken_ReadOnlyDir(t *testing.T) {
	tmp := t.TempDir()
	// Create the config dir as read-only to trigger WriteFile failure.
	readOnlyDir := filepath.Join(tmp, configDirName)
	if err := os.MkdirAll(readOnlyDir, 0700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// Create an existing file.
	tokenPath := filepath.Join(readOnlyDir, tokenFileName)
	if err := os.WriteFile(tokenPath, []byte("old"), 0400); err != nil {
		t.Fatalf("write: %v", err)
	}
	// Make dir read-only so WriteFile can't overwrite.
	os.Chmod(readOnlyDir, 0500)
	defer os.Chmod(readOnlyDir, 0700) // restore for cleanup

	t.Setenv("XDG_CONFIG_HOME", tmp)

	err := saveCachedToken("new-token")
	if err == nil {
		t.Fatal("expected error writing to read-only directory")
	}
}

func TestSaveCachedToken_MkdirAllFails(t *testing.T) {
	tmp := t.TempDir()
	// Create a regular file where the config dir would go, so MkdirAll fails.
	blockingFile := filepath.Join(tmp, configDirName)
	if err := os.WriteFile(blockingFile, []byte("not a dir"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}

	t.Setenv("XDG_CONFIG_HOME", tmp)

	err := saveCachedToken("some-token")
	if err == nil {
		t.Fatal("expected error when MkdirAll fails")
	}
}

func TestDeleteCachedToken_NoFile(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", tmp)

	// Should not panic or error when file doesn't exist.
	deleteCachedToken()
}

func TestLoadCachedToken_NoFile(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", tmp)

	_, err := loadCachedToken()
	if err == nil {
		t.Fatal("expected error when cache file doesn't exist")
	}
}

func TestLoadCachedToken_EmptyFile(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", tmp)

	dir := filepath.Join(tmp, configDirName)
	os.MkdirAll(dir, tokenDirPerms)
	os.WriteFile(filepath.Join(dir, tokenFileName), []byte(""), tokenFilePerms)

	token, err := loadCachedToken()
	if err != nil {
		t.Fatalf("loadCachedToken: %v", err)
	}
	if token != "" {
		t.Fatalf("expected empty token, got %q", token)
	}
}

func TestLoadCachedToken_WhitespaceStripped(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", tmp)

	dir := filepath.Join(tmp, configDirName)
	os.MkdirAll(dir, tokenDirPerms)
	os.WriteFile(filepath.Join(dir, tokenFileName), []byte("  ept_token.sig  \n"), tokenFilePerms)

	token, err := loadCachedToken()
	if err != nil {
		t.Fatalf("loadCachedToken: %v", err)
	}
	if token != "ept_token.sig" {
		t.Fatalf("expected trimmed token, got %q", token)
	}
}

func TestTokenCachePath_DefaultPath(t *testing.T) {
	// Ensure tokenCachePath returns a path under the config dir.
	path, err := tokenCachePath()
	if err != nil {
		t.Fatalf("tokenCachePath: %v", err)
	}
	if !filepath.IsAbs(path) {
		t.Fatalf("expected absolute path, got %q", path)
	}
	if filepath.Base(path) != tokenFileName {
		t.Fatalf("expected filename %q, got %q", tokenFileName, filepath.Base(path))
	}
	dir := filepath.Base(filepath.Dir(path))
	if dir != configDirName {
		t.Fatalf("expected parent dir %q, got %q", configDirName, dir)
	}
}

func TestTokenCachePath_XDGConfigHome(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", tmp)

	path, err := tokenCachePath()
	if err != nil {
		t.Fatalf("tokenCachePath: %v", err)
	}
	expected := filepath.Join(tmp, configDirName, tokenFileName)
	if path != expected {
		t.Fatalf("tokenCachePath = %q, want %q", path, expected)
	}
}

func TestRunBrowserAuth_ListenError(t *testing.T) {
	origAddr := listenAddr
	t.Cleanup(func() { listenAddr = origAddr })

	// Use an invalid address to force net.Listen to fail.
	listenAddr = "999.999.999.999:0"

	ctx := context.Background()
	logger := log.New(log.Writer(), "test: ", 0)
	_, err := runBrowserAuth(ctx, "http://127.0.0.1:1", logger)
	if err == nil {
		t.Fatal("expected listen error")
	}
	if !strings.Contains(err.Error(), "listen") {
		t.Fatalf("expected listen error, got: %v", err)
	}
}

func TestRunBrowserAuth_InternalTimeout(t *testing.T) {
	// Exercise the authTimeout path where the internal timeout fires
	// while the parent context is still alive.
	openBrowserFunc = func(string) error { return nil }
	t.Cleanup(func() { openBrowserFunc = openBrowser })

	origTimeout := authTimeout
	authTimeout = 50 * time.Millisecond
	t.Cleanup(func() { authTimeout = origTimeout })

	// Parent context lives much longer than authTimeout.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	logger := log.New(log.Writer(), "test: ", 0)
	_, err := runBrowserAuth(ctx, "http://127.0.0.1:1", logger)
	if err == nil {
		t.Fatal("expected timeout error")
	}
	if !strings.Contains(err.Error(), "authentication timed out") {
		t.Fatalf("expected 'authentication timed out' error, got: %v", err)
	}
}

func TestRunBrowserAuth_ContextCancelled(t *testing.T) {
	// Stub openBrowserFunc so tests don't launch real browser windows.
	openBrowserFunc = func(string) error { return nil }
	t.Cleanup(func() { openBrowserFunc = openBrowser })

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	logger := log.New(log.Writer(), "test: ", 0)
	_, err := runBrowserAuth(ctx, "http://127.0.0.1:1", logger)
	if err == nil {
		t.Fatal("expected error from cancelled context")
	}
}

func TestRunBrowserAuth_ShortTimeout(t *testing.T) {
	openBrowserFunc = func(string) error { return nil }
	t.Cleanup(func() { openBrowserFunc = openBrowser })

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	logger := log.New(log.Writer(), "test: ", 0)
	_, err := runBrowserAuth(ctx, "http://127.0.0.1:1", logger)
	if err == nil {
		t.Fatal("expected timeout error")
	}
}

func TestTokenCachePath_NoHome(t *testing.T) {
	// Unsetting HOME and XDG_CONFIG_HOME causes os.UserConfigDir to fail.
	t.Setenv("HOME", "")
	t.Setenv("XDG_CONFIG_HOME", "")

	_, err := tokenCachePath()
	if err == nil {
		t.Fatal("expected error when HOME is unset")
	}
}

func TestLoadCachedToken_NoHome(t *testing.T) {
	t.Setenv("HOME", "")
	t.Setenv("XDG_CONFIG_HOME", "")

	_, err := loadCachedToken()
	if err == nil {
		t.Fatal("expected error when tokenCachePath fails")
	}
}

func TestSaveCachedToken_NoHome(t *testing.T) {
	t.Setenv("HOME", "")
	t.Setenv("XDG_CONFIG_HOME", "")

	err := saveCachedToken("some-token")
	if err == nil {
		t.Fatal("expected error when tokenCachePath fails")
	}
}

func TestDeleteCachedToken_NoHome(t *testing.T) {
	t.Setenv("HOME", "")
	t.Setenv("XDG_CONFIG_HOME", "")

	// Should not panic — just silently return.
	deleteCachedToken()
}

func TestRunBrowserAuth_SuccessfulCallback(t *testing.T) {
	urlCh := make(chan string, 1)
	openBrowserFunc = func(url string) error {
		urlCh <- url
		return nil
	}
	t.Cleanup(func() { openBrowserFunc = openBrowser })

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	logger := log.New(os.Stderr, "test: ", 0)

	// Run browser auth in a goroutine; it will start a local server.
	type result struct {
		token string
		err   error
	}
	resultCh := make(chan result, 1)
	go func() {
		token, err := runBrowserAuth(ctx, "http://127.0.0.1:9999", logger)
		resultCh <- result{token, err}
	}()

	// Wait for openBrowserFunc to be called so we know the port.
	var capturedURL string
	select {
	case capturedURL = <-urlCh:
	case <-time.After(2 * time.Second):
		t.Fatal("openBrowserFunc was not called")
	}

	// Extract the port from the auth URL and hit the callback endpoint.
	// capturedURL is like http://127.0.0.1:9999/api/auth/tunnel/start?port=XXXXX
	parts := strings.SplitAfter(capturedURL, "port=")
	if len(parts) != 2 {
		t.Fatalf("unexpected auth URL: %s", capturedURL)
	}
	port := parts[1]

	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%s/callback?token=ept_test-token.sig", port))
	if err != nil {
		t.Fatalf("callback request: %v", err)
	}
	resp.Body.Close()

	res := <-resultCh
	if res.err != nil {
		t.Fatalf("expected success, got error: %v", res.err)
	}
	if res.token != "ept_test-token.sig" {
		t.Fatalf("expected token, got %q", res.token)
	}
}

func TestRunBrowserAuth_ErrorCallback(t *testing.T) {
	urlCh := make(chan string, 1)
	openBrowserFunc = func(url string) error {
		urlCh <- url
		return nil
	}
	t.Cleanup(func() { openBrowserFunc = openBrowser })

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	logger := log.New(os.Stderr, "test: ", 0)

	type result struct {
		token string
		err   error
	}
	resultCh := make(chan result, 1)
	go func() {
		token, err := runBrowserAuth(ctx, "http://127.0.0.1:9999", logger)
		resultCh <- result{token, err}
	}()

	var capturedURL string
	select {
	case capturedURL = <-urlCh:
	case <-time.After(2 * time.Second):
		t.Fatal("openBrowserFunc was not called")
	}

	parts := strings.SplitAfter(capturedURL, "port=")
	port := parts[1]

	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%s/callback?error=access_denied", port))
	if err != nil {
		t.Fatalf("callback request: %v", err)
	}
	resp.Body.Close()

	res := <-resultCh
	if res.err == nil {
		t.Fatal("expected error from error callback")
	}
	if !strings.Contains(res.err.Error(), "access_denied") {
		t.Fatalf("expected access_denied in error, got %v", res.err)
	}
}

func TestRunBrowserAuth_EmptyTokenCallback(t *testing.T) {
	urlCh := make(chan string, 1)
	openBrowserFunc = func(url string) error {
		urlCh <- url
		return nil
	}
	t.Cleanup(func() { openBrowserFunc = openBrowser })

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	logger := log.New(os.Stderr, "test: ", 0)

	type result struct {
		token string
		err   error
	}
	resultCh := make(chan result, 1)
	go func() {
		token, err := runBrowserAuth(ctx, "http://127.0.0.1:9999", logger)
		resultCh <- result{token, err}
	}()

	var capturedURL string
	select {
	case capturedURL = <-urlCh:
	case <-time.After(2 * time.Second):
		t.Fatal("openBrowserFunc was not called")
	}

	parts := strings.SplitAfter(capturedURL, "port=")
	port := parts[1]

	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%s/callback", port))
	if err != nil {
		t.Fatalf("callback request: %v", err)
	}
	resp.Body.Close()

	res := <-resultCh
	if res.err == nil {
		t.Fatal("expected error for empty token callback")
	}
	if !strings.Contains(res.err.Error(), "no token") {
		t.Fatalf("expected 'no token' error, got %v", res.err)
	}
}

func TestRunBrowserAuth_OpenBrowserError(t *testing.T) {
	urlCh := make(chan string, 1)
	openBrowserFunc = func(url string) error {
		urlCh <- url
		return fmt.Errorf("no display")
	}
	t.Cleanup(func() { openBrowserFunc = openBrowser })

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	logger := log.New(os.Stderr, "test: ", 0)

	type result struct {
		token string
		err   error
	}
	resultCh := make(chan result, 1)
	go func() {
		token, err := runBrowserAuth(ctx, "http://127.0.0.1:9999", logger)
		resultCh <- result{token, err}
	}()

	var capturedURL string
	select {
	case capturedURL = <-urlCh:
	case <-time.After(2 * time.Second):
		t.Fatal("openBrowserFunc was not called")
	}

	// Even with browser error, the callback server is still running.
	// Send a successful token to verify it still works.
	parts := strings.SplitAfter(capturedURL, "port=")
	port := parts[1]

	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%s/callback?token=ept_recovered.sig", port))
	if err != nil {
		t.Fatalf("callback request: %v", err)
	}
	resp.Body.Close()

	res := <-resultCh
	if res.err != nil {
		t.Fatalf("expected success despite browser error, got: %v", res.err)
	}
	if res.token != "ept_recovered.sig" {
		t.Fatalf("expected token, got %q", res.token)
	}
}

func TestEnsureTunnelAuthToken_BrowserFlowSuccessAndCaches(t *testing.T) {
	urlCh := make(chan string, 1)
	openBrowserFunc = func(url string) error {
		urlCh <- url
		return nil
	}
	t.Cleanup(func() { openBrowserFunc = openBrowser })

	tmp := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", tmp)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	logger := log.New(os.Stderr, "test: ", 0)

	type result struct {
		token string
		err   error
	}
	resultCh := make(chan result, 1)
	go func() {
		token, err := ensureTunnelAuthToken(ctx, "http://127.0.0.1:9999", logger)
		resultCh <- result{token, err}
	}()

	var capturedURL string
	select {
	case capturedURL = <-urlCh:
	case <-time.After(2 * time.Second):
		t.Fatal("openBrowserFunc was not called")
	}

	parts := strings.SplitAfter(capturedURL, "port=")
	port := parts[1]

	freshToken := "ept_eyJzdWIiOiIxIiwiZW1haWwiOiJhQGIuY29tIiwiZXhwIjo5OTk5OTk5OTk5fQ.freshsig"
	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%s/callback?token=%s", port, freshToken))
	if err != nil {
		t.Fatalf("callback request: %v", err)
	}
	resp.Body.Close()

	res := <-resultCh
	if res.err != nil {
		t.Fatalf("expected success, got: %v", res.err)
	}
	if res.token != freshToken {
		t.Fatalf("expected fresh token, got %q", res.token)
	}

	// Verify token was cached.
	cached, err := loadCachedToken()
	if err != nil {
		t.Fatalf("loadCachedToken: %v", err)
	}
	if cached != freshToken {
		t.Fatalf("cached token = %q, want %q", cached, freshToken)
	}
}

func TestOpenBrowser_UnsupportedPlatform(t *testing.T) {
	if runtime.GOOS == "darwin" || runtime.GOOS == "linux" || runtime.GOOS == "windows" {
		t.Skip("only tests unsupported-platform branch")
	}
	err := openBrowser("http://example.com")
	if err == nil {
		t.Fatal("expected unsupported platform error")
	}
}

func TestEnsureTunnelAuthToken_BrowserFlowSaveCacheFailure(t *testing.T) {
	urlCh := make(chan string, 1)
	openBrowserFunc = func(url string) error {
		urlCh <- url
		return nil
	}
	t.Cleanup(func() { openBrowserFunc = openBrowser })

	// Use a read-only path so saveCachedToken fails.
	tmp := t.TempDir()
	blockingFile := filepath.Join(tmp, configDirName)
	os.WriteFile(blockingFile, []byte("not a dir"), 0644)
	t.Setenv("XDG_CONFIG_HOME", tmp)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	logger := log.New(os.Stderr, "test: ", 0)

	type result struct {
		token string
		err   error
	}
	resultCh := make(chan result, 1)
	go func() {
		token, err := ensureTunnelAuthToken(ctx, "http://127.0.0.1:9999", logger)
		resultCh <- result{token, err}
	}()

	var capturedURL string
	select {
	case capturedURL = <-urlCh:
	case <-time.After(2 * time.Second):
		t.Fatal("openBrowserFunc was not called")
	}

	parts := strings.SplitAfter(capturedURL, "port=")
	port := parts[1]

	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%s/callback?token=ept_fresh.sig", port))
	if err != nil {
		t.Fatalf("callback request: %v", err)
	}
	resp.Body.Close()

	res := <-resultCh
	// Should still succeed even if caching fails.
	if res.err != nil {
		t.Fatalf("expected success despite cache failure, got: %v", res.err)
	}
	if res.token != "ept_fresh.sig" {
		t.Fatalf("expected token, got %q", res.token)
	}
}

func TestOpenBrowserCommandSpec(t *testing.T) {
	tests := []struct {
		goos     string
		wantName string
		wantArgs []string
		wantErr  string
	}{
		{goos: "darwin", wantName: "open", wantArgs: []string{"http://example.com"}},
		{goos: "linux", wantName: "xdg-open", wantArgs: []string{"http://example.com"}},
		{goos: "windows", wantName: "cmd", wantArgs: []string{"/c", "start", "http://example.com"}},
		{goos: "plan9", wantErr: "unsupported platform"},
	}

	for _, tt := range tests {
		t.Run(tt.goos, func(t *testing.T) {
			name, args, err := openBrowserCommandSpec(tt.goos, "http://example.com")
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("openBrowserCommandSpec error = %v, want substring %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("openBrowserCommandSpec error = %v", err)
			}
			if name != tt.wantName || fmt.Sprint(args) != fmt.Sprint(tt.wantArgs) {
				t.Fatalf("openBrowserCommandSpec = %q %v, want %q %v", name, args, tt.wantName, tt.wantArgs)
			}
		})
	}
}

func TestOpenBrowser_StartError(t *testing.T) {
	orig := newBrowserCommand
	t.Cleanup(func() { newBrowserCommand = orig })

	newBrowserCommand = func(name string, args ...string) browserCommand {
		return &stubBrowserCommand{err: fmt.Errorf("exec: not found")}
	}

	err := openBrowser("http://example.com")
	if err == nil {
		t.Fatal("expected error from Start()")
	}
	if !strings.Contains(err.Error(), "exec: not found") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestOpenBrowser_UnsupportedPlatformViaVar(t *testing.T) {
	origGOOS := runtimeGOOS
	t.Cleanup(func() { runtimeGOOS = origGOOS })

	runtimeGOOS = "plan9"
	err := openBrowser("http://example.com")
	if err == nil {
		t.Fatal("expected unsupported platform error")
	}
	if !strings.Contains(err.Error(), "unsupported platform") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestOpenBrowserUsesPlatformCommand(t *testing.T) {
	orig := newBrowserCommand
	t.Cleanup(func() { newBrowserCommand = orig })

	var gotName string
	var gotArgs []string
	cmd := &stubBrowserCommand{}
	newBrowserCommand = func(name string, args ...string) browserCommand {
		gotName = name
		gotArgs = append([]string(nil), args...)
		return cmd
	}

	wantName, wantArgs, err := openBrowserCommandSpec(runtime.GOOS, "http://example.com")
	if err != nil {
		t.Skipf("current platform not supported by openBrowser: %v", err)
	}

	if err := openBrowser("http://example.com"); err != nil {
		t.Fatalf("openBrowser: %v", err)
	}
	if !cmd.started {
		t.Fatal("expected browser command to be started")
	}
	if gotName != wantName || fmt.Sprint(gotArgs) != fmt.Sprint(wantArgs) {
		t.Fatalf("openBrowser command = %q %v, want %q %v", gotName, gotArgs, wantName, wantArgs)
	}
}
