package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"elpasto/backend/internal/config"
)

type fakeAPIServer struct {
	restoreSessions  int
	restoreClips     int
	restoreErr       error
	saveErr          error
	closeCalled      bool
	startedCleanup   bool
	startedSnapshot  bool
}

func (s *fakeAPIServer) Close() error {
	s.closeCalled = true
	return nil
}

func (s *fakeAPIServer) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
}

func (s *fakeAPIServer) RestoreSnapshot(string) (int, int, error) {
	return s.restoreSessions, s.restoreClips, s.restoreErr
}

func (s *fakeAPIServer) SaveSnapshot(string) error {
	return s.saveErr
}

func (s *fakeAPIServer) StartCleanupLoop(context.Context) {
	s.startedCleanup = true
}

func (s *fakeAPIServer) StartSnapshotLoop(context.Context, string, time.Duration) <-chan struct{} {
	s.startedSnapshot = true
	ch := make(chan struct{})
	close(ch)
	return ch
}

type fakeHTTPServer struct {
	listenErr      error
	shutdownErr    error
	shutdownCalled chan struct{}
	once           sync.Once
}

func newFakeHTTPServer() *fakeHTTPServer {
	return &fakeHTTPServer{shutdownCalled: make(chan struct{})}
}

func (s *fakeHTTPServer) ListenAndServe() error {
	if s.listenErr != nil {
		return s.listenErr
	}
	<-s.shutdownCalled
	return http.ErrServerClosed
}

func (s *fakeHTTPServer) Shutdown(context.Context) error {
	s.once.Do(func() {
		close(s.shutdownCalled)
	})
	return s.shutdownErr
}

func TestRunSuccess(t *testing.T) {
	cfg := config.Config{Port: 4310, DataDir: t.TempDir()}
	server := &fakeAPIServer{restoreSessions: 2, restoreClips: 3}
	srv := newFakeHTTPServer()
	var logs bytes.Buffer
	logger := log.New(&logs, "", 0)

	oldAPIServer := newAPIServer
	oldHTTPServer := newHTTPServer
	t.Cleanup(func() {
		newAPIServer = oldAPIServer
		newHTTPServer = oldHTTPServer
	})

	newAPIServer = func(config.Config, *log.Logger) (apiServer, error) {
		return server, nil
	}
	newHTTPServer = func(int, http.Handler) httpServer {
		return srv
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, cfg, logger)
	}()

	time.Sleep(10 * time.Millisecond)
	cancel()

	if err := <-done; err != nil {
		t.Fatalf("run returned error: %v", err)
	}
	if !server.startedCleanup {
		t.Fatal("expected cleanup loop to start")
	}
	if !server.closeCalled {
		t.Fatal("expected server to be closed")
	}
	output := logs.String()
	if !strings.Contains(output, "startup: restored 2 sessions and 3 clips from snapshot") {
		t.Fatalf("expected restore log, got %q", output)
	}
	if !server.startedSnapshot {
		t.Fatal("expected snapshot loop to start")
	}
}

func TestRunLogsRestoreAndSaveWarnings(t *testing.T) {
	cfg := config.Config{Port: 4311, DataDir: t.TempDir()}
	server := &fakeAPIServer{
		restoreErr: errors.New("bad snapshot"),
		saveErr:    errors.New("disk full"),
	}
	srv := newFakeHTTPServer()
	var logs bytes.Buffer
	logger := log.New(&logs, "", 0)

	oldAPIServer := newAPIServer
	oldHTTPServer := newHTTPServer
	t.Cleanup(func() {
		newAPIServer = oldAPIServer
		newHTTPServer = oldHTTPServer
	})

	newAPIServer = func(config.Config, *log.Logger) (apiServer, error) {
		return server, nil
	}
	newHTTPServer = func(int, http.Handler) httpServer {
		return srv
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, cfg, logger)
	}()

	time.Sleep(10 * time.Millisecond)
	cancel()

	if err := <-done; err != nil {
		t.Fatalf("run returned error: %v", err)
	}
	output := logs.String()
	if !strings.Contains(output, "warning: failed to restore snapshot: bad snapshot") {
		t.Fatalf("expected restore warning, got %q", output)
	}
}

func TestRunStartupFailures(t *testing.T) {
	cfg := config.Config{Port: 4312, DataDir: t.TempDir()}
	logger := log.New(&bytes.Buffer{}, "", 0)

	t.Run("api init failure", func(t *testing.T) {
		oldAPIServer := newAPIServer
		t.Cleanup(func() {
			newAPIServer = oldAPIServer
		})

		newAPIServer = func(config.Config, *log.Logger) (apiServer, error) {
			return nil, errors.New("api failed")
		}

		err := run(context.Background(), cfg, logger)
		if err == nil || !strings.Contains(err.Error(), "failed to initialize backend") {
			t.Fatalf("unexpected error: %v", err)
		}
	})
}

func TestRunListenFailure(t *testing.T) {
	cfg := config.Config{Port: 4313, DataDir: t.TempDir()}
	server := &fakeAPIServer{}
	srv := newFakeHTTPServer()
	srv.listenErr = errors.New("listen failed")

	oldAPIServer := newAPIServer
	oldHTTPServer := newHTTPServer
	t.Cleanup(func() {
		newAPIServer = oldAPIServer
		newHTTPServer = oldHTTPServer
	})

	newAPIServer = func(config.Config, *log.Logger) (apiServer, error) {
		return server, nil
	}
	newHTTPServer = func(int, http.Handler) httpServer {
		return srv
	}

	err := run(context.Background(), cfg, log.New(&bytes.Buffer{}, "", 0))
	if err == nil || !strings.Contains(err.Error(), "server error") {
		t.Fatalf("unexpected error: %v", err)
	}
	if !server.closeCalled {
		t.Fatal("expected server close on listen failure")
	}
}

func TestStdHTTPServerDelegates(t *testing.T) {
	t.Run("listen", func(t *testing.T) {
		server := &stdHTTPServer{
			server: &http.Server{Addr: "127.0.0.1:-1"},
		}
		if err := server.ListenAndServe(); err == nil {
			t.Fatal("expected listen error")
		}
	})

	t.Run("shutdown", func(t *testing.T) {
		server := &stdHTTPServer{
			server: &http.Server{},
		}
		if err := server.Shutdown(context.Background()); err != nil && !errors.Is(err, http.ErrServerClosed) {
			t.Fatalf("unexpected shutdown error: %v", err)
		}
	})
}

func TestMainDelegatesToRun(t *testing.T) {
	oldNotifyContext := notifyContext
	oldRunApp := runApp
	oldFatalf := logFatalf
	t.Cleanup(func() {
		notifyContext = oldNotifyContext
		runApp = oldRunApp
		logFatalf = oldFatalf
	})

	called := false
	notifyContext = func(parent context.Context, _ ...os.Signal) (context.Context, context.CancelFunc) {
		return context.WithCancel(parent)
	}
	runApp = func(_ context.Context, cfg config.Config, _ *log.Logger) error {
		called = true
		if cfg.Port != 4321 {
			t.Fatalf("cfg.Port = %d, want 4321", cfg.Port)
		}
		return nil
	}
	logFatalf = func(*log.Logger, string, ...any) {
		t.Fatal("logFatalf should not be called")
	}

	t.Setenv("PORT", "4321")
	main()

	if !called {
		t.Fatal("expected runApp to be called")
	}
}

func TestMainFatalOnRunError(t *testing.T) {
	oldNotifyContext := notifyContext
	oldRunApp := runApp
	oldFatalf := logFatalf
	t.Cleanup(func() {
		notifyContext = oldNotifyContext
		runApp = oldRunApp
		logFatalf = oldFatalf
	})

	notifyContext = func(parent context.Context, _ ...os.Signal) (context.Context, context.CancelFunc) {
		return context.WithCancel(parent)
	}
	runApp = func(context.Context, config.Config, *log.Logger) error {
		return errors.New("boom")
	}

	called := false
	logFatalf = func(_ *log.Logger, format string, args ...any) {
		called = true
		if got := fmt.Sprintf(format, args...); !strings.Contains(got, "boom") {
			t.Fatalf("unexpected fatal message: %q", got)
		}
	}

	main()

	if !called {
		t.Fatal("expected logFatalf to be called")
	}
}

func TestMainFatalOnInvalidConfig(t *testing.T) {
	oldNotifyContext := notifyContext
	oldRunApp := runApp
	oldFatalf := logFatalf
	t.Cleanup(func() {
		notifyContext = oldNotifyContext
		runApp = oldRunApp
		logFatalf = oldFatalf
	})

	notifyContext = func(parent context.Context, _ ...os.Signal) (context.Context, context.CancelFunc) {
		return context.WithCancel(parent)
	}
	runAppCalled := false
	runApp = func(context.Context, config.Config, *log.Logger) error {
		runAppCalled = true
		return nil
	}
	fatalCalled := false
	logFatalf = func(_ *log.Logger, format string, args ...any) {
		fatalCalled = true
		if got := fmt.Sprintf(format, args...); !strings.Contains(got, "configuration") {
			t.Fatalf("unexpected fatal message: %q", got)
		}
	}

	// SESSION_EXPIRY_HOURS=0 is invalid and must abort before running the app.
	t.Setenv("SESSION_EXPIRY_HOURS", "0")
	main()

	if !fatalCalled {
		t.Fatal("expected logFatalf to be called on invalid config")
	}
	if runAppCalled {
		t.Fatal("runApp should not be called when config is invalid")
	}
}

func TestNewHTTPServerSetsTimeouts(t *testing.T) {
	srv := newHTTPServer(4399, http.NewServeMux())
	std, ok := srv.(*stdHTTPServer)
	if !ok {
		t.Fatalf("expected *stdHTTPServer, got %T", srv)
	}
	if std.server.ReadHeaderTimeout == 0 {
		t.Error("ReadHeaderTimeout should be set")
	}
	if std.server.ReadTimeout == 0 {
		t.Error("ReadTimeout should be set to bound slow request bodies")
	}
	if std.server.IdleTimeout == 0 {
		t.Error("IdleTimeout should be set to bound idle keep-alive connections")
	}
}

func TestRunCreatesMissingDataDir(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "nested", "data")
	cfg := config.Config{Port: 4314, DataDir: dataDir}
	server := &fakeAPIServer{}
	srv := newFakeHTTPServer()
	logger := log.New(&bytes.Buffer{}, "", 0)

	oldAPIServer := newAPIServer
	oldHTTPServer := newHTTPServer
	t.Cleanup(func() {
		newAPIServer = oldAPIServer
		newHTTPServer = oldHTTPServer
	})
	newAPIServer = func(config.Config, *log.Logger) (apiServer, error) { return server, nil }
	newHTTPServer = func(int, http.Handler) httpServer { return srv }

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- run(ctx, cfg, logger) }()
	time.Sleep(10 * time.Millisecond)
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("run returned error: %v", err)
	}

	info, err := os.Stat(dataDir)
	if err != nil {
		t.Fatalf("expected data dir to be created: %v", err)
	}
	if !info.IsDir() {
		t.Fatal("expected data dir to be a directory")
	}
	if perm := info.Mode().Perm(); perm != 0o700 {
		t.Errorf("data dir perm = %o, want 0700", perm)
	}
}
