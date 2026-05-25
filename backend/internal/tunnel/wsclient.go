package tunnel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coder/websocket"
)

var (
	// ErrRelayDisconnected indicates the relay was working but lost connection.
	ErrRelayDisconnected = fmt.Errorf("server relay disconnected")
	// ErrRelayUnsupported indicates the server doesn't support the relay endpoint (404).
	ErrRelayUnsupported = fmt.Errorf("server relay not supported")
	// ErrRelayAuthRejected indicates the server rejected the tunnel auth token (401/403).
	ErrRelayAuthRejected = fmt.Errorf("tunnel authentication rejected")
)

// WSRelay connects to the server relay WebSocket and runs the tunnel proxy loop.
type WSRelay struct {
	serverURL   string
	token       string
	peerID      string
	label       string
	port        int
	proxy       *Proxy
	logger      *log.Logger
	accessToken string // stable token for the lifetime of this CLI process
	authToken   string // tunnel auth token (ept_...) for Google OAuth gate
}

func NewWSRelay(serverURL, token, peerID, label string, port int, proxy *Proxy, logger *log.Logger, authToken string) *WSRelay {
	// Generate a stable access token once — reused across reconnects so the
	// tunnel URL doesn't change.
	accessToken, err := generateAccessToken()
	if err != nil {
		// Extremely unlikely; fall back to letting the server generate one.
		accessToken = ""
	}
	return &WSRelay{
		serverURL:   strings.TrimRight(serverURL, "/"),
		token:       token,
		peerID:      peerID,
		label:       label,
		port:        port,
		proxy:       proxy,
		logger:      logger,
		accessToken: accessToken,
		authToken:   authToken,
	}
}

// Connect attempts WebSocket upgrade and runs the relay loop.
// Returns error if the initial connection fails (caller falls back to WebRTC).
func (w *WSRelay) Connect(ctx context.Context) error {
	// Build WebSocket URL with proper scheme replacement
	wsURL := w.serverURL
	if strings.HasPrefix(wsURL, "https://") {
		wsURL = "wss://" + wsURL[len("https://"):]
	} else if strings.HasPrefix(wsURL, "http://") {
		wsURL = "ws://" + wsURL[len("http://"):]
	}
	wsURL += fmt.Sprintf("/api/tunnel/ws?session=%s&peer=%s&access_token=%s",
		url.QueryEscape(w.token), url.QueryEscape(w.peerID), url.QueryEscape(w.accessToken))

	var dialOpts *websocket.DialOptions
	if w.authToken != "" {
		dialOpts = &websocket.DialOptions{
			HTTPHeader: http.Header{
				"Authorization": []string{"Bearer " + w.authToken},
			},
		}
	}

	conn, resp, err := websocket.Dial(ctx, wsURL, dialOpts)
	if err != nil {
		if resp != nil {
			switch resp.StatusCode {
			case http.StatusNotFound:
				return ErrRelayUnsupported
			case http.StatusUnauthorized, http.StatusForbidden:
				return ErrRelayAuthRejected
			}
		}
		return fmt.Errorf("websocket connect: %w", err)
	}
	defer conn.CloseNow()
	conn.SetReadLimit(1 << 20)

	// Read tunnel:config
	_, data, err := conn.Read(ctx)
	if err != nil {
		return fmt.Errorf("read config: %w", err)
	}
	var config ConfigMsg
	if err := json.Unmarshal(data, &config); err != nil {
		return fmt.Errorf("decode config: %w", err)
	}
	w.proxy.SetPrefix(config.Prefix)
	w.logger.Printf("server relay connected")

	// Send tunnel:announce
	ann, _ := Encode(AnnounceMsg{Type: MsgAnnounce, Label: w.label, Port: w.port})
	if err := conn.Write(ctx, websocket.MessageText, ann); err != nil {
		return fmt.Errorf("send announce: %w", err)
	}

	w.logger.Printf("tunnel active via server relay at %s/api/tunnel/...", w.serverURL)

	// Relay loop: read requests from WS, proxy to localhost, write responses to WS
	send := func(data []byte) error {
		return conn.Write(ctx, websocket.MessageText, data)
	}
	recv := make(chan []byte, 64)
	readErr := make(chan error, 1)

	go func() {
		defer close(recv)
		for {
			_, msg, err := conn.Read(ctx)
			if err != nil {
				readErr <- err
				return
			}
			select {
			case recv <- msg:
			case <-ctx.Done():
				return
			}
		}
	}()

	w.proxy.Handle(ctx, "server", send, recv)

	// Determine why the proxy loop ended.
	if ctx.Err() != nil {
		conn.Close(websocket.StatusNormalClosure, "shutdown")
		return ctx.Err()
	}
	select {
	case err := <-readErr:
		if err != nil {
			conn.CloseNow()
			return ErrRelayDisconnected
		}
	default:
	}
	conn.Close(websocket.StatusNormalClosure, "shutdown")
	return nil
}

// ConnectWithRetry calls Connect in a loop with exponential backoff.
// An initial connection failure is returned immediately so the caller can fall
// back to WebRTC. Once the relay has been established, any subsequent
// disconnection triggers a retry loop (1s, 2s, 4s, 8s, 16s, 30s cap).
// Backoff resets to 1s only after a connection that stayed up for at least
// minStableConnection, preventing tight retry loops on flapping relays.
func (w *WSRelay) ConnectWithRetry(ctx context.Context) error {
	backoff := time.Second
	const maxBackoff = 30 * time.Second
	const minStableConnection = 30 * time.Second
	first := true

	for {
		connStart := time.Now()
		err := w.Connect(ctx)

		if ctx.Err() != nil {
			return nil
		}

		if err == nil {
			// Clean close — done.
			return nil
		}

		// Auth rejection is always fatal — do not retry or fall back.
		if errors.Is(err, ErrRelayAuthRejected) {
			return err
		}

		if first {
			// First attempt failed before the relay was established — let caller fall back.
			if !errors.Is(err, ErrRelayDisconnected) {
				return err
			}
			// Managed to connect but immediately disconnected; still retry.
		}
		first = false

		// Only reset backoff if the connection was stable long enough.
		// This prevents a flapping relay from retrying every second forever.
		if errors.Is(err, ErrRelayDisconnected) && time.Since(connStart) >= minStableConnection {
			backoff = time.Second
		}

		w.logger.Printf("server relay disconnected (%v) — retrying in %s", err, backoff)
		select {
		case <-time.After(backoff):
		case <-ctx.Done():
			return nil
		}

		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}
