package api

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"elpasto/backend/internal/cleanup"
	"elpasto/backend/internal/config"
	"elpasto/backend/internal/events"
	"elpasto/backend/internal/frontend"
	"elpasto/backend/internal/ratelimit"
	"elpasto/backend/internal/stats"
	"elpasto/backend/internal/store"
	"elpasto/backend/internal/tunnel"
	"elpasto/backend/internal/tunnelauth"
)

type Server struct {
	cfg            config.Config
	logger         *log.Logger
	store          *store.Store
	broker         *events.Broker
	limiter        *ratelimit.Limiter
	cleanup        *cleanup.Runner
	stats          *stats.Collector
	cancel         context.CancelFunc
	handler        http.Handler
	tunnelRegistry *tunnel.TunnelRegistry
	tunnelAuth     *tunnelauth.Handler
}

type connectionReporter struct {
	broker   *events.Broker
	registry *tunnel.TunnelRegistry
}

func (cr *connectionReporter) SSEStats() (int, int) {
	if cr.broker == nil {
		return 0, 0
	}
	return cr.broker.SubscriberStats()
}

func (cr *connectionReporter) TunnelCount() int {
	if cr.registry == nil {
		return 0
	}
	return cr.registry.TunnelCount()
}

func New(cfg config.Config, logger *log.Logger) (*Server, error) {
	if logger == nil {
		logger = log.Default()
	}

	metaStore := store.New(cfg.SessionExpiryHours)
	broker := events.New()

	// Validate tunnel auth config at startup.
	if err := cfg.ValidateTunnelAuth(); err != nil {
		return nil, fmt.Errorf("server: %w", err)
	}
	if err := cfg.ValidateTunnelBaseURL(); err != nil {
		return nil, fmt.Errorf("server: %w", err)
	}

	server := &Server{
		cfg:     cfg,
		logger:  logger,
		store:   metaStore,
		broker:  broker,
		limiter: ratelimit.New(),
	}

	// Initialize tunnel auth if configured.
	if cfg.TunnelAuthEnabled() {
		emailSet := make(map[string]struct{}, len(cfg.TunnelAuthAllowedEmails))
		for _, e := range cfg.TunnelAuthAllowedEmails {
			emailSet[e] = struct{}{}
		}
		domainSet := make(map[string]struct{}, len(cfg.TunnelAuthAllowedDomains))
		for _, d := range cfg.TunnelAuthAllowedDomains {
			domainSet[d] = struct{}{}
		}
		authHandler, err := tunnelauth.New(tunnelauth.Config{
			ClientID:          cfg.GoogleOAuthClientID,
			ClientSecret:      cfg.GoogleOAuthClientSecret,
			AuthSecret:        cfg.TunnelAuthSecret,
			AllowedEmails:     emailSet,
			AllowedDomains:    domainSet,
			TrustProxyHeaders: cfg.TrustProxyHeaders,
			PublicBaseURL:     cfg.TunnelAuthPublicURL,
		}, nil, logger)
		if err != nil {
			return nil, fmt.Errorf("server: tunnel auth: %w", err)
		}
		server.tunnelAuth = authHandler
		logger.Printf("tunnel auth enabled (Google OAuth)")
	}

	server.cleanup = cleanup.New(metaStore, logger)
	server.tunnelRegistry = tunnel.NewRegistry(5, 100, cfg.TunnelBaseURL)
	server.stats = stats.New(server.store, &connectionReporter{
		broker:   broker,
		registry: server.tunnelRegistry,
	})
	ctx, cancel := context.WithCancel(context.Background())
	server.cancel = cancel
	go server.stats.StartDailyReset(ctx)
	server.handler = server.routes()

	return server, nil
}

func (s *Server) Handler() http.Handler {
	return s.handler
}

// Close cancels background goroutines.
func (s *Server) Close() error {
	if s.tunnelRegistry != nil {
		s.tunnelRegistry.Shutdown()
	}
	if s.cancel != nil {
		s.cancel()
	}
	return nil
}

func (s *Server) SaveSnapshot(path string) error {
	return s.store.SaveSnapshot(path)
}

func (s *Server) RestoreSnapshot(path string) (int, int, error) {
	return s.store.RestoreSnapshot(path)
}

func (s *Server) ActiveSessionIDs() []int64 {
	return s.store.ActiveSessionIDs()
}

func (s *Server) StartCleanupLoop(ctx context.Context) {
	s.cleanup.Start(ctx, s.cfg.CleanupInterval)
}

func (s *Server) StartSnapshotLoop(ctx context.Context, path string, interval time.Duration) <-chan struct{} {
	return s.store.StartSnapshotLoop(ctx, path, interval, s.logger)
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", s.handleHealth)
	mux.HandleFunc("POST /api/sessions", s.handleCreateSession)
	mux.HandleFunc("POST /api/sessions/batch", s.handleBatchCreateSessions)
	mux.HandleFunc("GET /api/sessions/lookup", s.handleLookupSession)
	mux.HandleFunc("GET /api/sessions/{token}", s.handleGetSession)
	mux.HandleFunc("GET /api/sessions/{token}/events", s.handleSessionEvents)
	mux.HandleFunc("POST /api/sessions/{token}/signal", s.handlePublishPeerSignal)
	mux.HandleFunc("POST /api/sessions/{token}/tunnels/{peerId}/viewer", s.handleClaimTunnelViewer)

	mux.HandleFunc("GET /api/downloads/", s.handleListDownloads)
	mux.HandleFunc("GET /api/downloads/{filename}", s.handleDownloadFile)

	mux.HandleFunc("GET /api/stats", s.handleStats)
	mux.Handle("GET /metrics", s.newMetricsHandler())

	// Tunnel auth routes (only registered when auth is enabled).
	if s.tunnelAuth != nil {
		mux.HandleFunc("GET /api/auth/tunnel/start", s.handleTunnelAuthStart)
		mux.HandleFunc("GET /api/auth/tunnel/callback", s.handleTunnelAuthCallback)
	}

	// Build tunnel auth validator if enabled.
	var authValidator tunnel.TunnelAuthValidator
	if s.tunnelAuth != nil {
		authValidator = func(raw string) error {
			_, err := s.tunnelAuth.ValidateTunnelToken(raw)
			return err
		}
	}

	relayHandler := tunnel.NewRelayHandler(
		s.tunnelRegistry,
		s.broker,
		func(token string) bool { return s.store.GetSessionByToken(token) != nil },
		func(r *http.Request) string { return clientIP(r, s.cfg.TrustProxyHeaders) },
		s.logger,
		authValidator,
	)
	mux.Handle("/api/tunnel/", relayHandler)

	plCfg := plausibleConfig{
		scriptURL:         s.cfg.PlausibleScriptURL,
		eventURL:          s.cfg.PlausibleEventURL,
		trustProxyHeaders: s.cfg.TrustProxyHeaders,
	}
	plClient := &http.Client{Timeout: 10 * time.Second}
	mux.Handle("GET /pl/script.js", newPlausibleScriptHandler(plCfg, plClient))
	mux.Handle("POST /pl/event", newPlausibleEventHandler(plCfg, plClient))

	mux.Handle("/", frontend.Handler())

	mainHandler := s.withMiddleware(mux)

	// When TunnelBaseURL is configured with a different host, set up
	// virtual-host routing so tunnel.* requests only see the relay handler.
	if s.cfg.TunnelBaseURL != "" {
		tunnelMux := http.NewServeMux()
		tunnelMux.HandleFunc("/{peerId}/{accessToken}/{path...}", func(w http.ResponseWriter, r *http.Request) {
			// Rewrite path to match the relay handler's route pattern.
			r.URL.Path = "/api/tunnel/" + r.PathValue("peerId") + "/" + r.PathValue("accessToken") + "/" + r.PathValue("path")
			relayHandler.ServeHTTP(w, r)
		})
		tunnelHandler := s.withMiddleware(tunnelMux)

		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			host := r.Host
			if idx := strings.Index(host, ":"); idx >= 0 {
				host = host[:idx]
			}
			if strings.HasPrefix(host, "tunnel.") {
				tunnelHandler.ServeHTTP(w, r)
				return
			}
			mainHandler.ServeHTTP(w, r)
		})
	}

	return mainHandler
}

func (s *Server) withMiddleware(next http.Handler) http.Handler {
	return s.recoverMiddleware(s.logMiddleware(s.statsMiddleware(s.corsMiddleware(s.securityHeadersMiddleware(next)))))
}
