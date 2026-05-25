// elpasto-tunnel exposes a local HTTP service or directory to peers in an
// elPasto session via a server-relay WebSocket (preferred) or WebRTC data
// channel fallback.
//
// Usage:
//
//	elpasto-tunnel --session TOKEN --port 3000 [--label "frontend"] [--server https://your-elpasto-server]
//	elpasto-tunnel --session TOKEN --dir ./public  [--label "docs"]   [--server https://your-elpasto-server]
//	elpasto-tunnel --session TOKEN --port 3000 --mode webrtc
//
// --port  proxies to an already-running local HTTP service.
// --dir   starts a built-in file server for the given directory.
// Exactly one of --port or --dir is required.
//
// --mode controls the transport:
//
//	auto   (default) try server relay first, fall back to WebRTC on any failure
//	relay  server relay only — auth rejection is fatal
//	webrtc WebRTC peer-to-peer only — no server relay, no auth required
//
// During local development, use --server http://127.0.0.1:8080 to talk directly
// to the Go backend (not the Next.js dev proxy).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"elpasto/backend/internal/tunnel"

	"github.com/google/uuid"
	"github.com/pion/webrtc/v4"
)

type tunnelCLIConfig struct {
	session   string
	port      int
	dir       string
	label     string
	serverURL string
	mode      string
}

var (
	osExit      = os.Exit
	runMain     = run
	executeMain = execute
)

func main() {
	osExit(runMain(os.Args[1:], os.Stderr))
}

func run(args []string, stderr io.Writer) int {
	cfg, exitCode := parseCLIArgs(args, stderr)
	if exitCode != 0 {
		return exitCode
	}

	logger := log.New(stderr, "[elpasto-tunnel] ", log.LstdFlags)
	executeMain(cfg, logger)
	return 0
}

func parseCLIArgs(args []string, stderr io.Writer) (tunnelCLIConfig, int) {
	var cfg tunnelCLIConfig

	fs := flag.NewFlagSet("elpasto-tunnel", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.StringVar(&cfg.session, "session", "", "Session token (required)")
	fs.IntVar(&cfg.port, "port", 0, "Local port to proxy")
	fs.StringVar(&cfg.dir, "dir", "", "Directory to serve (alternative to --port)")
	fs.StringVar(&cfg.label, "label", "", "Human-readable service label")
	fs.StringVar(&cfg.serverURL, "server", "http://127.0.0.1:8080", "elPasto server URL (override for self-hosted or canonical instance)")
	fs.StringVar(&cfg.mode, "mode", "auto", "Transport mode: auto, relay, webrtc")
	fs.Usage = func() {
		fmt.Fprintf(stderr, "Usage of %s:\n", fs.Name())
		fs.PrintDefaults()
	}

	if err := fs.Parse(args); err != nil {
		return tunnelCLIConfig{}, 2
	}

	switch cfg.mode {
	case "auto", "relay", "webrtc":
	default:
		fmt.Fprintf(stderr, "elpasto-tunnel: --mode must be auto, relay, or webrtc (got %q)\n", cfg.mode)
		fs.Usage()
		return tunnelCLIConfig{}, 1
	}

	if cfg.session == "" {
		fmt.Fprintln(stderr, "elpasto-tunnel: --session is required")
		fs.Usage()
		return tunnelCLIConfig{}, 1
	}
	if (cfg.port <= 0) == (cfg.dir == "") {
		fmt.Fprintln(stderr, "elpasto-tunnel: exactly one of --port or --dir is required")
		fs.Usage()
		return tunnelCLIConfig{}, 1
	}

	return cfg, 0
}

func execute(cfg tunnelCLIConfig, logger *log.Logger) {
	peerID := uuid.New().String()

	var targetURL string

	if cfg.dir != "" {
		// Validate directory exists.
		info, err := os.Stat(cfg.dir)
		if err != nil || !info.IsDir() {
			logger.Fatalf("--dir %q is not a valid directory", cfg.dir)
		}

		// Start a built-in file server on a random port.
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			logger.Fatalf("listen: %v", err)
		}
		targetURL = fmt.Sprintf("http://%s", ln.Addr())
		srv := &http.Server{Handler: http.FileServer(http.Dir(cfg.dir))}
		go func() {
			if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
				logger.Fatalf("file server: %v", err)
			}
		}()
		logger.Printf("serving %s on %s", cfg.dir, ln.Addr())
	} else {
		targetURL = fmt.Sprintf("http://127.0.0.1:%d", cfg.port)
	}

	proxy, err := tunnel.NewProxy(targetURL, peerID)
	if err != nil {
		logger.Fatalf("proxy: %v", err)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	lbl := cfg.label
	if lbl == "" {
		if cfg.dir != "" {
			lbl = cfg.dir
		} else {
			lbl = targetURL
		}
	}

	// --- Server relay attempt (skipped in webrtc mode) ---
	if cfg.mode != "webrtc" {
		// Try cached tunnel auth token if one exists. If the server doesn't
		// require auth, the token is harmlessly ignored.
		authToken, _ := loadCachedToken()
		if authToken != "" && isTokenExpired(authToken) {
			authToken = "" // expired locally — don't bother sending it
		}

		wsRelay := tunnel.NewWSRelay(cfg.serverURL, cfg.session, peerID, lbl, cfg.port, proxy, logger, authToken)
		logger.Printf("trying server relay at %s …", cfg.serverURL)
		relayErr := wsRelay.ConnectWithRetry(ctx)

		if errors.Is(relayErr, tunnel.ErrRelayAuthRejected) {
			if cfg.mode == "relay" {
				// In relay mode, attempt OAuth login before giving up.
				deleteCachedToken()
				freshToken, err := ensureTunnelAuthToken(ctx, cfg.serverURL, logger)
				if err != nil {
					logger.Fatalf("tunnel auth failed: %v", err)
				}
				authToken = freshToken

				wsRelay = tunnel.NewWSRelay(cfg.serverURL, cfg.session, peerID, lbl, cfg.port, proxy, logger, authToken)
				relayErr = wsRelay.ConnectWithRetry(ctx)

				if errors.Is(relayErr, tunnel.ErrRelayAuthRejected) {
					deleteCachedToken()
					logger.Fatalf("tunnel auth rejected after fresh login — check your Google account permissions")
				}
			} else {
				// auto mode: auth rejected, fall through to WebRTC.
				logger.Printf("server relay requires auth — falling back to WebRTC")
			}
		}

		if ctx.Err() != nil {
			logger.Println("shutting down …")
			return
		}
		if relayErr == nil {
			logger.Println("shutting down …")
			return
		}

		if cfg.mode == "relay" {
			// relay mode: no fallback — auth rejection was already handled
			// above (OAuth retry + fatal), so only non-auth errors reach here.
			logger.Fatalf("server relay failed: %v", relayErr)
		}

		// auto mode: relay failed, fall back to WebRTC.
		logger.Printf("server relay unavailable (%v) — falling back to WebRTC", relayErr)
	} else {
		logger.Printf("using WebRTC mode (no server relay)")
	}

	// Fetch TURN credentials from session metadata.
	turnCreds, err := tunnel.FetchTurnCredentials(cfg.serverURL, cfg.session)
	if err != nil {
		logger.Printf("TURN credentials: %v (continuing with STUN only)", err)
	}

	iceServers := []webrtc.ICEServer{
		{URLs: []string{"stun:stun.l.google.com:19302"}},
	}
	if turnCreds != nil {
		iceServers = append(iceServers, webrtc.ICEServer{
			URLs:       turnCreds.URLs,
			Username:   turnCreds.Username,
			Credential: turnCreds.Credential,
		})
		logger.Printf("TURN relay enabled via %s", turnCreds.URLs[0])
	}

	webrtcConfig := webrtc.Configuration{ICEServers: iceServers}

	sigClient := tunnel.NewSignalingClient(cfg.serverURL, cfg.session, peerID)

	handler := func(ctx context.Context, remotePeerID string, send func([]byte) error, recv <-chan []byte) {
		logger.Printf("tunnel channel open with peer %s — proxying %s", remotePeerID[:8], targetURL)
		proxy.Handle(ctx, remotePeerID, send, recv)
		logger.Printf("tunnel channel closed for peer %s", remotePeerID[:8])
	}

	pm := tunnel.NewPeerManager(peerID, sigClient, handler, logger, webrtcConfig)

	// Start SSE subscription in background; reconnect on transient errors.
	go func() {
		for {
			logger.Printf("connecting to %s …", cfg.serverURL)
			err := sigClient.Subscribe(ctx, func(msg tunnel.SignalMessage) {
				pm.HandleSignal(ctx, msg)
			})
			if ctx.Err() != nil {
				return
			}
			if err != nil {
				logger.Printf("SSE error: %v — retrying in 3s", err)
				select {
				case <-time.After(3 * time.Second):
				case <-ctx.Done():
					return
				}
			}
		}
	}()

	// Wait briefly, then announce our presence to the session.
	time.Sleep(500 * time.Millisecond)
	if err := sigClient.Announce(ctx); err != nil {
		logger.Printf("announce: %v", err)
	}

	logger.Printf("tunnel active — session %s — proxying %s (%s) — peer %s", cfg.session, targetURL, lbl, peerID[:8])

	<-ctx.Done()
	logger.Println("shutting down …")
	pm.CloseAll()
	_ = sigClient.Leave(context.Background())
}
