package tunnel

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"sync/atomic"

	"github.com/pion/webrtc/v4"
)

// TunnelHandler is called when a browser peer opens a tunnel data channel.
// It receives the peerId of the browser and a channel to send responses on.
type TunnelHandler func(ctx context.Context, peerID string, send func([]byte) error, recv <-chan []byte)

// PeerManager manages WebRTC peer connections for one tunnel session.
type PeerManager struct {
	localPeerID  string
	signaling    *SignalingClient
	handler      TunnelHandler
	logger       *log.Logger
	webrtcConfig webrtc.Configuration

	mu    sync.Mutex
	peers map[string]*peerState
}

type peerState struct {
	pc             *webrtc.PeerConnection
	makingOffer    atomic.Bool
	polite         bool
	tunnelAttached atomic.Bool
	tunnelMu       sync.Mutex
	tunnelCh       *webrtc.DataChannel
	tunnelRecv     chan []byte
	cancelTunnel   context.CancelFunc
}

// NewPeerManager creates a PeerManager.
func NewPeerManager(localPeerID string, signaling *SignalingClient, handler TunnelHandler, logger *log.Logger, config webrtc.Configuration) *PeerManager {
	return &PeerManager{
		localPeerID:  localPeerID,
		signaling:    signaling,
		handler:      handler,
		logger:       logger,
		webrtcConfig: config,
		peers:        make(map[string]*peerState),
	}
}

// HandleSignal processes an incoming signaling message from the SSE stream.
func (m *PeerManager) HandleSignal(ctx context.Context, msg SignalMessage) {
	switch msg.SignalType {
	case "announce":
		m.handleAnnounce(ctx, msg.FromPeerID)
	case "leave":
		m.cleanupPeer(msg.FromPeerID)
	case "description":
		m.handleDescription(ctx, msg)
	case "ice-candidate":
		m.handleICECandidate(msg)
	}
}

func (m *PeerManager) handleAnnounce(ctx context.Context, remotePeerID string) {
	m.mu.Lock()
	_, exists := m.peers[remotePeerID]
	m.mu.Unlock()
	if exists {
		return
	}

	if _, err := m.ensurePeer(ctx, remotePeerID); err != nil {
		m.logger.Printf("peer: ensure peer %s: %v", remotePeerID, err)
		return
	}

	// Send a targeted announce back so the browser starts negotiating.
	if err := m.signaling.Send(ctx, SignalMessage{
		FromPeerID: m.localPeerID,
		ToPeerID:   remotePeerID,
		SignalType: "announce",
	}); err != nil {
		m.logger.Printf("peer: announce to %s: %v", remotePeerID, err)
	}

	// Tunnel data channel creation is deferred to OnConnectionStateChange
	// ("connected") to avoid offer collision during initial negotiation.
}

func (m *PeerManager) handleDescription(ctx context.Context, msg SignalMessage) {
	state, err := m.ensurePeer(ctx, msg.FromPeerID)
	if err != nil {
		m.logger.Printf("peer: ensure peer %s: %v", msg.FromPeerID, err)
		return
	}

	raw, err := json.Marshal(msg.Description)
	if err != nil {
		return
	}
	var sd webrtc.SessionDescription
	if err := json.Unmarshal(raw, &sd); err != nil {
		m.logger.Printf("peer: unmarshal description: %v", err)
		return
	}

	// Perfect negotiation: polite peer rolls back on collision.
	offerCollision := sd.Type == webrtc.SDPTypeOffer &&
		(state.makingOffer.Load() || state.pc.SignalingState() != webrtc.SignalingStateStable)

	if !state.polite && offerCollision {
		return // impolite: drop
	}

	if offerCollision {
		if err := state.pc.SetLocalDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeRollback}); err != nil {
			m.logger.Printf("peer: rollback: %v", err)
		}
	}

	if err := state.pc.SetRemoteDescription(sd); err != nil {
		m.logger.Printf("peer: set remote description: %v", err)
		return
	}

	if sd.Type == webrtc.SDPTypeOffer {
		answer, err := state.pc.CreateAnswer(nil)
		if err != nil {
			m.logger.Printf("peer: create answer: %v", err)
			return
		}
		if err := state.pc.SetLocalDescription(answer); err != nil {
			m.logger.Printf("peer: set local description: %v", err)
			return
		}
		desc := state.pc.LocalDescription()
		descMap := map[string]any{"type": desc.Type.String(), "sdp": desc.SDP}
		if err := m.signaling.Send(ctx, SignalMessage{
			FromPeerID:  m.localPeerID,
			ToPeerID:    msg.FromPeerID,
			SignalType:  "description",
			Description: descMap,
		}); err != nil {
			m.logger.Printf("peer: send answer: %v", err)
		}
	}
}

func (m *PeerManager) handleICECandidate(msg SignalMessage) {
	m.mu.Lock()
	state := m.peers[msg.FromPeerID]
	m.mu.Unlock()
	if state == nil {
		return
	}

	raw, err := json.Marshal(msg.Candidate)
	if err != nil {
		return
	}
	var candidate webrtc.ICECandidateInit
	if err := json.Unmarshal(raw, &candidate); err != nil {
		m.logger.Printf("peer: unmarshal candidate: %v", err)
		return
	}
	if err := state.pc.AddICECandidate(candidate); err != nil {
		m.logger.Printf("peer: add ICE candidate: %v", err)
	}
}

func (m *PeerManager) ensurePeer(ctx context.Context, remotePeerID string) (*peerState, error) {
	m.mu.Lock()
	if state, ok := m.peers[remotePeerID]; ok {
		m.mu.Unlock()
		return state, nil
	}

	// Reserve slot under lock to prevent concurrent creation for the same peer.
	pc, err := webrtc.NewPeerConnection(m.webrtcConfig)
	if err != nil {
		m.mu.Unlock()
		return nil, fmt.Errorf("create peer connection: %w", err)
	}

	polite := m.localPeerID > remotePeerID // higher peer ID = polite
	state := &peerState{pc: pc, polite: polite}
	m.peers[remotePeerID] = state
	m.mu.Unlock()

	// ICE candidates → send via signaling
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		ci := c.ToJSON()
		raw, _ := json.Marshal(ci)
		var candidateMap map[string]any
		_ = json.Unmarshal(raw, &candidateMap)
		_ = m.signaling.Send(ctx, SignalMessage{
			FromPeerID: m.localPeerID,
			ToPeerID:   remotePeerID,
			SignalType: "ice-candidate",
			Candidate:  candidateMap,
		})
	})

	// Negotiation needed → create and send offer
	pc.OnNegotiationNeeded(func() {
		state.makingOffer.Store(true)
		defer state.makingOffer.Store(false)

		offer, err := pc.CreateOffer(nil)
		if err != nil {
			m.logger.Printf("peer: create offer: %v", err)
			return
		}
		if err := pc.SetLocalDescription(offer); err != nil {
			m.logger.Printf("peer: set local description: %v", err)
			return
		}
		desc := pc.LocalDescription()
		descMap := map[string]any{"type": desc.Type.String(), "sdp": desc.SDP}
		if err := m.signaling.Send(ctx, SignalMessage{
			FromPeerID:  m.localPeerID,
			ToPeerID:    remotePeerID,
			SignalType:  "description",
			Description: descMap,
		}); err != nil {
			m.logger.Printf("peer: send offer: %v", err)
		}
	})

	// Incoming data channel (answerer side for tunnel channel from browser)
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		if dc.Label() == "tunnel" {
			m.attachTunnelChannel(ctx, remotePeerID, state, dc)
		}
	})

	pc.OnConnectionStateChange(func(cs webrtc.PeerConnectionState) {
		if cs == webrtc.PeerConnectionStateConnected && !state.tunnelAttached.Load() {
			ch, err := pc.CreateDataChannel("tunnel", &webrtc.DataChannelInit{
				Ordered: boolPtr(true),
			})
			if err != nil {
				m.logger.Printf("peer: create tunnel channel: %v", err)
			} else {
				m.attachTunnelChannel(ctx, remotePeerID, state, ch)
			}
		}
		if cs == webrtc.PeerConnectionStateFailed ||
			cs == webrtc.PeerConnectionStateClosed ||
			cs == webrtc.PeerConnectionStateDisconnected {
			m.cleanupPeer(remotePeerID)
		}
	})

	// Mirror browser logic: the peer with the lower ID creates the first data
	// channel to trigger negotiation. Without this, when the CLI has the lower
	// ID no one initiates and the connection never establishes.
	if m.localPeerID < remotePeerID {
		ch, err := pc.CreateDataChannel("tunnel", &webrtc.DataChannelInit{
			Ordered: boolPtr(true),
		})
		if err != nil {
			m.logger.Printf("peer: create tunnel channel: %v", err)
		} else {
			m.attachTunnelChannel(ctx, remotePeerID, state, ch)
		}
	}

	return state, nil
}

func (m *PeerManager) attachTunnelChannel(ctx context.Context, remotePeerID string, state *peerState, dc *webrtc.DataChannel) {
	if !state.tunnelAttached.CompareAndSwap(false, true) {
		return // already attached
	}
	recv := make(chan []byte, 64)
	tunnelCtx, cancel := context.WithCancel(ctx)

	state.setTunnel(dc, recv, cancel)

	dc.OnOpen(func() {
		// Send tunnel:announce so the browser knows we're ready.
		raw, _ := json.Marshal(AnnounceMsg{Type: MsgAnnounce})
		_ = dc.SendText(string(raw))

		send := func(data []byte) error {
			return dc.SendText(string(data))
		}
		go m.handler(tunnelCtx, remotePeerID, send, recv)
	})

	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		data := msg.Data
		select {
		case recv <- data:
		default:
			m.logger.Printf("peer: tunnel recv buffer full for %s, dropping message", remotePeerID)
		}
	})

	dc.OnClose(func() {
		cancel()
		close(recv)
		detachTunnelChannel(state, dc)
	})
}

func detachTunnelChannel(state *peerState, dc *webrtc.DataChannel) {
	if !state.clearTunnel(dc) {
		return
	}
}

func (m *PeerManager) cleanupPeer(remotePeerID string) {
	m.mu.Lock()
	state, ok := m.peers[remotePeerID]
	delete(m.peers, remotePeerID)
	m.mu.Unlock()
	if !ok {
		return
	}
	if cancel := state.tunnelCancel(); cancel != nil {
		cancel()
	}
	_ = state.pc.Close()
}

// CloseAll closes all peer connections.
func (m *PeerManager) CloseAll() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.peers))
	for id := range m.peers {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		m.cleanupPeer(id)
	}
}

func boolPtr(b bool) *bool { return &b }

func (s *peerState) setTunnel(dc *webrtc.DataChannel, recv chan []byte, cancel context.CancelFunc) {
	s.tunnelMu.Lock()
	defer s.tunnelMu.Unlock()
	s.tunnelCh = dc
	s.tunnelRecv = recv
	s.cancelTunnel = cancel
}

func (s *peerState) clearTunnel(dc *webrtc.DataChannel) bool {
	s.tunnelMu.Lock()
	defer s.tunnelMu.Unlock()
	if s.tunnelCh != dc {
		return false
	}
	s.tunnelCh = nil
	s.tunnelRecv = nil
	s.cancelTunnel = nil
	s.tunnelAttached.Store(false)
	return true
}

func (s *peerState) tunnelCancel() context.CancelFunc {
	s.tunnelMu.Lock()
	defer s.tunnelMu.Unlock()
	return s.cancelTunnel
}

func (s *peerState) tunnelSnapshot() (*webrtc.DataChannel, chan []byte, bool, context.CancelFunc) {
	s.tunnelMu.Lock()
	defer s.tunnelMu.Unlock()
	return s.tunnelCh, s.tunnelRecv, s.tunnelAttached.Load(), s.cancelTunnel
}
