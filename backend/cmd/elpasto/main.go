package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"elpasto/backend/internal/api"
	"elpasto/backend/internal/config"
	"elpasto/backend/internal/storage"
)

type uploadStore interface {
	SweepOrphanedUploads(activeSessionIDs []int64) (int, error)
}

type apiServer interface {
	Close() error
	Handler() http.Handler
	ActiveSessionIDs() []int64
	RestoreSnapshot(path string) (int, int, error)
	SaveSnapshot(path string) error
	StartCleanupLoop(ctx context.Context)
	StartSnapshotLoop(ctx context.Context, path string, interval time.Duration) <-chan struct{}
}

type httpServer interface {
	ListenAndServe() error
	Shutdown(ctx context.Context) error
}

type stdHTTPServer struct {
	server *http.Server
}

func (s *stdHTTPServer) ListenAndServe() error {
	return s.server.ListenAndServe()
}

func (s *stdHTTPServer) Shutdown(ctx context.Context) error {
	return s.server.Shutdown(ctx)
}

var (
	newUploadStore = func(uploadsDir string) uploadStore {
		return storage.New(uploadsDir)
	}
	newAPIServer = func(cfg config.Config, logger *log.Logger) (apiServer, error) {
		return api.New(cfg, logger)
	}
	newHTTPServer = func(port int, handler http.Handler) httpServer {
		return &stdHTTPServer{
			server: &http.Server{
				Addr:              ":" + strconv.Itoa(port),
				Handler:           handler,
				ReadHeaderTimeout: 5 * time.Second,
			},
		}
	}
	notifyContext = signal.NotifyContext
	runApp        = run
	logFatalf     = func(logger *log.Logger, format string, args ...any) {
		logger.Fatalf(format, args...)
	}
)

func main() {
	cfg := config.FromEnv()
	logger := log.New(os.Stdout, "", log.LstdFlags)
	ctx, stop := notifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := runApp(ctx, cfg, logger); err != nil {
		logFatalf(logger, "%v", err)
	}
}

func run(ctx context.Context, cfg config.Config, logger *log.Logger) error {
	snapshotPath := filepath.Join(cfg.DataDir, "snapshot.json")

	server, err := newAPIServer(cfg, logger)
	if err != nil {
		return fmt.Errorf("failed to initialize backend: %w", err)
	}
	defer server.Close()

	sessions, clips, restoreErr := server.RestoreSnapshot(snapshotPath)
	if restoreErr != nil {
		logger.Printf("warning: failed to restore snapshot: %v", restoreErr)
	} else if sessions > 0 {
		logger.Printf("startup: restored %d sessions and %d clips from snapshot", sessions, clips)
	}

	blobStore := newUploadStore(cfg.UploadsDir)
	if restoreErr == nil {
		swept, err := blobStore.SweepOrphanedUploads(server.ActiveSessionIDs())
		if err != nil {
			return fmt.Errorf("startup upload sweep failed: %w", err)
		}
		if swept > 0 {
			logger.Printf("startup: removed %d orphaned upload directories", swept)
		}
	} else {
		logger.Printf("warning: skipped startup upload sweep because snapshot restore failed")
	}

	server.StartCleanupLoop(ctx)
	snapshotDone := server.StartSnapshotLoop(ctx, snapshotPath, 5*time.Minute)
	httpServer := newHTTPServer(cfg.Port, server.Handler())

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
	}()

	logger.Printf("elPasto Go backend listening on http://localhost:%d", cfg.Port)
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return fmt.Errorf("server error: %w", err)
	}

	// Wait for the snapshot loop to finish its shutdown save before exiting.
	<-snapshotDone
	return nil
}
