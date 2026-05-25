package tunnel

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// SignalMessage mirrors the TypeScript PeerSignalMessage shape used by the browser.
type SignalMessage struct {
	FromPeerID  string                 `json:"fromPeerId"`
	ToPeerID    string                 `json:"toPeerId,omitempty"`
	SignalType  string                 `json:"signalType"`
	Description map[string]any         `json:"description,omitempty"`
	Candidate   map[string]any         `json:"candidate,omitempty"`
}

// SignalingClient connects to one elPasto session for WebRTC signaling.
type SignalingClient struct {
	serverURL string // e.g. https://example.com
	token     string
	peerID    string
	client    *http.Client // short-lived requests (POST)
	sseClient *http.Client // long-lived SSE stream (no timeout)
}

// NewSignalingClient creates a new SignalingClient.
func NewSignalingClient(serverURL, token, peerID string) *SignalingClient {
	return &SignalingClient{
		serverURL: strings.TrimRight(serverURL, "/"),
		token:     token,
		peerID:    peerID,
		client:    &http.Client{Timeout: 10 * time.Second},
		sseClient: &http.Client{}, // no timeout; relies on context cancellation
	}
}

// Subscribe opens an SSE connection and streams incoming peer:signal events.
// It calls onMsg for each relevant message and blocks until ctx is cancelled.
func (c *SignalingClient) Subscribe(ctx context.Context, onMsg func(SignalMessage)) error {
	url := fmt.Sprintf("%s/api/sessions/%s/events", c.serverURL, c.token)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("signaling: create request: %w", err)
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Cache-Control", "no-cache")

	resp, err := c.sseClient.Do(req)
	if err != nil {
		return fmt.Errorf("signaling: connect SSE: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("signaling: SSE returned %d", resp.StatusCode)
	}

	scanner := bufio.NewScanner(resp.Body)
	var eventName string
	var dataBuf strings.Builder

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			// Blank line = end of event
			if eventName == "peer:signal" && dataBuf.Len() > 0 {
				var msg SignalMessage
				if err := json.Unmarshal([]byte(dataBuf.String()), &msg); err == nil {
					// Only process messages directed at us (broadcast or targeted)
					if msg.FromPeerID != c.peerID {
						if msg.ToPeerID == "" || msg.ToPeerID == c.peerID {
							onMsg(msg)
						}
					}
				}
			}
			eventName = ""
			dataBuf.Reset()
			continue
		}
		if v, ok := strings.CutPrefix(line, "event: "); ok {
			eventName = v
		} else if v, ok := strings.CutPrefix(line, "data: "); ok {
			dataBuf.WriteString(v)
		}
	}

	if err := scanner.Err(); err != nil {
		if ctx.Err() != nil {
			return nil // cancelled cleanly
		}
		return fmt.Errorf("signaling: SSE read: %w", err)
	}
	return nil
}

// Send posts a signal message to the session.
func (c *SignalingClient) Send(ctx context.Context, msg SignalMessage) error {
	url := fmt.Sprintf("%s/api/sessions/%s/signal", c.serverURL, c.token)
	body, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("signaling: marshal: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("signaling: create post: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("signaling: post: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("signaling: post returned %d", resp.StatusCode)
	}
	return nil
}

// Announce sends an announce message to all peers in the session.
func (c *SignalingClient) Announce(ctx context.Context) error {
	return c.Send(ctx, SignalMessage{
		FromPeerID: c.peerID,
		SignalType: "announce",
	})
}

// Leave sends a leave message so peers clean up the connection state.
func (c *SignalingClient) Leave(ctx context.Context) error {
	return c.Send(ctx, SignalMessage{
		FromPeerID: c.peerID,
		SignalType: "leave",
	})
}
