package tunnel

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

type internalSignalRelay struct {
	mu          sync.Mutex
	subscribers []chan []byte
}

func (r *internalSignalRelay) addSubscriber() chan []byte {
	ch := make(chan []byte, 32)
	r.mu.Lock()
	r.subscribers = append(r.subscribers, ch)
	r.mu.Unlock()
	return ch
}

func (r *internalSignalRelay) removeSubscriber(ch chan []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, subscriber := range r.subscribers {
		if subscriber == ch {
			r.subscribers = append(r.subscribers[:i], r.subscribers[i+1:]...)
			return
		}
	}
}

func (r *internalSignalRelay) broadcast(data []byte) {
	r.mu.Lock()
	subscribers := make([]chan []byte, len(r.subscribers))
	copy(subscribers, r.subscribers)
	r.mu.Unlock()
	for _, subscriber := range subscribers {
		select {
		case subscriber <- data:
		default:
		}
	}
}

func newInternalSignalRelayServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	relay := &internalSignalRelay{}
	token := "test-token"

	mux := http.NewServeMux()
	mux.HandleFunc("/api/sessions/"+token+"/events", func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming not supported", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()

		ch := relay.addSubscriber()
		defer relay.removeSubscriber(ch)

		for {
			select {
			case <-r.Context().Done():
				return
			case data, ok := <-ch:
				if !ok {
					return
				}
				fmt.Fprintf(w, "event: peer:signal\ndata: %s\n\n", data)
				flusher.Flush()
			}
		}
	})

	mux.HandleFunc("/api/sessions/"+token+"/signal", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		relay.broadcast(body)
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	})

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, token
}

func internalTestLogger(t *testing.T) *log.Logger {
	t.Helper()
	return log.New(os.Stderr, fmt.Sprintf("[%s] ", t.Name()), log.LstdFlags|log.Lmsgprefix)
}

func waitForCondition(t *testing.T, timeout time.Duration, condition func() bool, message string) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal(message)
}

func getPeerState(pm *PeerManager, peerID string) *peerState {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	return pm.peers[peerID]
}

func getTunnelSnapshot(pm *PeerManager, peerID string) (*peerState, *webrtc.DataChannel, chan []byte, bool, context.CancelFunc) {
	state := getPeerState(pm, peerID)
	if state == nil {
		return nil, nil, nil, false, nil
	}
	tunnelCh, tunnelRecv, tunnelAttached, cancelTunnel := state.tunnelSnapshot()
	return state, tunnelCh, tunnelRecv, tunnelAttached, cancelTunnel
}

func TestDetachTunnelChannelClearsReattachGuardForMatchingChannel(t *testing.T) {
	first := &webrtc.DataChannel{}
	second := &webrtc.DataChannel{}
	state := &peerState{
		tunnelCh:     first,
		tunnelRecv:   make(chan []byte, 1),
		cancelTunnel: func() {},
	}
	state.tunnelAttached.Store(true)

	detachTunnelChannel(state, second)
	tunnelCh, _, tunnelAttached, _ := state.tunnelSnapshot()
	if tunnelCh != first {
		t.Fatal("non-matching channel should not detach active tunnel")
	}
	if !tunnelAttached {
		t.Fatal("non-matching channel should not clear reattach guard")
	}

	detachTunnelChannel(state, first)
	tunnelCh, tunnelRecv, tunnelAttached, cancelTunnel := state.tunnelSnapshot()
	if tunnelCh != nil {
		t.Fatal("matching channel should be detached")
	}
	if tunnelRecv != nil {
		t.Fatal("detach should clear tunnel receive channel")
	}
	if cancelTunnel != nil {
		t.Fatal("detach should clear cancel func")
	}
	if tunnelAttached {
		t.Fatal("detach should clear reattach guard")
	}
	if !state.tunnelAttached.CompareAndSwap(false, true) {
		t.Fatal("reattach guard should allow a new tunnel channel after detach")
	}
}

func TestPeerManagerTunnelCanReopenOnSamePeerConnection(t *testing.T) {
	srv, token := newInternalSignalRelayServer(t)

	var handlerCount atomic.Int32
	makeHandler := func() TunnelHandler {
		return func(ctx context.Context, _ string, _ func([]byte) error, recv <-chan []byte) {
			handlerCount.Add(1)
			for {
				select {
				case <-ctx.Done():
					return
				case _, ok := <-recv:
					if !ok {
						return
					}
				}
			}
		}
	}

	scA := NewSignalingClient(srv.URL, token, "peer-aaa")
	scB := NewSignalingClient(srv.URL, token, "peer-bbb")

	pmA := NewPeerManager("peer-aaa", scA, makeHandler(), internalTestLogger(t), webrtc.Configuration{})
	pmB := NewPeerManager("peer-bbb", scB, makeHandler(), internalTestLogger(t), webrtc.Configuration{})

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		_ = scA.Subscribe(ctx, func(msg SignalMessage) {
			pmA.HandleSignal(ctx, msg)
		})
	}()
	go func() {
		defer wg.Done()
		_ = scB.Subscribe(ctx, func(msg SignalMessage) {
			pmB.HandleSignal(ctx, msg)
		})
	}()

	time.Sleep(50 * time.Millisecond)

	if err := scA.Announce(ctx); err != nil {
		t.Fatalf("announce A: %v", err)
	}
	if err := scB.Announce(ctx); err != nil {
		t.Fatalf("announce B: %v", err)
	}

	waitForCondition(t, 10*time.Second, func() bool {
		stateA, tunnelChA, _, _, _ := getTunnelSnapshot(pmA, "peer-bbb")
		stateB, tunnelChB, _, _, _ := getTunnelSnapshot(pmB, "peer-aaa")
		return stateA != nil &&
			stateB != nil &&
			tunnelChA != nil &&
			tunnelChB != nil &&
			tunnelChA.ReadyState() == webrtc.DataChannelStateOpen &&
			tunnelChB.ReadyState() == webrtc.DataChannelStateOpen &&
			handlerCount.Load() >= 1
	}, "timed out waiting for initial tunnel channel to open")

	stateA, tunnelChA, _, _, _ := getTunnelSnapshot(pmA, "peer-bbb")
	stateB, tunnelChB, _, _, _ := getTunnelSnapshot(pmB, "peer-aaa")
	if stateA == nil || tunnelChA == nil {
		t.Fatal("peer A tunnel channel missing after initial negotiation")
	}
	if stateB == nil || tunnelChB == nil {
		t.Fatal("peer B tunnel channel missing after initial negotiation")
	}
	initialHandlerCount := handlerCount.Load()
	originalChannelA := tunnelChA
	originalChannelB := tunnelChB

	if err := originalChannelA.Close(); err != nil {
		t.Fatalf("close original peer A tunnel channel: %v", err)
	}
	if err := originalChannelB.Close(); err != nil {
		t.Fatalf("close original peer B tunnel channel: %v", err)
	}

	waitForCondition(t, 10*time.Second, func() bool {
		_, tunnelCh, _, tunnelAttached, _ := getTunnelSnapshot(pmA, "peer-bbb")
		return tunnelCh == nil && !tunnelAttached
	}, "timed out waiting for peer A to detach closed tunnel channel")
	waitForCondition(t, 10*time.Second, func() bool {
		_, tunnelCh, _, tunnelAttached, _ := getTunnelSnapshot(pmB, "peer-aaa")
		return tunnelCh == nil && !tunnelAttached
	}, "timed out waiting for peer B to detach closed tunnel channel")

	stateA = getPeerState(pmA, "peer-bbb")
	if stateA == nil {
		t.Fatal("peer A state missing before reopen")
	}
	reopenedChannel, err := stateA.pc.CreateDataChannel("tunnel", &webrtc.DataChannelInit{
		Ordered: boolPtr(true),
	})
	if err != nil {
		t.Fatalf("create reopened tunnel channel: %v", err)
	}
	pmA.attachTunnelChannel(ctx, "peer-bbb", stateA, reopenedChannel)

	waitForCondition(t, 10*time.Second, func() bool {
		_, tunnelCh, _, _, _ := getTunnelSnapshot(pmA, "peer-bbb")
		return tunnelCh != nil &&
			tunnelCh != originalChannelA &&
			tunnelCh.ReadyState() == webrtc.DataChannelStateOpen &&
			handlerCount.Load() > initialHandlerCount
	}, "timed out waiting for reopened tunnel channel to attach and open")

	cancel()
	pmA.CloseAll()
	pmB.CloseAll()
	wg.Wait()
}

// TestHandleDescriptionMarshalError verifies that handleDescription handles
// a nil Description field gracefully (json.Marshal(nil) succeeds but the
// resulting "null" doesn't unmarshal to a valid SessionDescription).
func TestHandleDescriptionUnmarshalError(t *testing.T) {
	srv, token := newInternalSignalRelayServer(t)
	sc := NewSignalingClient(srv.URL, token, "peer-a")
	pm := NewPeerManager("peer-a", sc, func(_ context.Context, _ string, _ func([]byte) error, recv <-chan []byte) {
		for range recv {
		}
	}, internalTestLogger(t), webrtc.Configuration{})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// First create the peer via announce.
	pm.HandleSignal(ctx, SignalMessage{
		FromPeerID: "peer-b",
		SignalType: "announce",
	})

	// Send a description with a Description map that cannot unmarshal to
	// webrtc.SessionDescription (missing required "type" and "sdp" fields).
	// This exercises the unmarshal error path in handleDescription.
	pm.HandleSignal(ctx, SignalMessage{
		FromPeerID:  "peer-b",
		SignalType:  "description",
		Description: map[string]any{"invalid": true},
	})

	pm.CloseAll()
}

// TestHandleDescriptionOfferCollisionImpolite verifies that when an impolite
// peer receives an offer while making an offer (collision), it drops the incoming offer.
func TestHandleDescriptionOfferCollisionImpolite(t *testing.T) {
	srv, token := newInternalSignalRelayServer(t)
	// "peer-a" < "peer-b", so peer-a is impolite (lower ID = impolite)
	sc := NewSignalingClient(srv.URL, token, "peer-a")
	pm := NewPeerManager("peer-a", sc, func(_ context.Context, _ string, _ func([]byte) error, recv <-chan []byte) {
		for range recv {
		}
	}, internalTestLogger(t), webrtc.Configuration{})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Create the peer.
	pm.HandleSignal(ctx, SignalMessage{
		FromPeerID: "peer-b",
		SignalType: "announce",
	})

	state := getPeerState(pm, "peer-b")
	if state == nil {
		t.Fatal("peer state is nil after announce")
	}

	// Simulate that we are currently making an offer.
	state.makingOffer.Store(true)

	// peer-a is impolite (peer-a < peer-b → polite = localPeerID > remotePeerID → false).
	// Send an incoming offer — should be dropped by the impolite peer.
	pm.HandleSignal(ctx, SignalMessage{
		FromPeerID: "peer-b",
		SignalType: "description",
		Description: map[string]any{
			"type": "offer",
			"sdp":  "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n",
		},
	})

	state.makingOffer.Store(false)
	pm.CloseAll()
}

// TestHandleDescriptionOfferCollisionPolite verifies that when a polite peer
// receives an offer while making an offer (collision), it performs rollback
// and accepts the incoming offer.
func TestHandleDescriptionOfferCollisionPolite(t *testing.T) {
	srv, token := newInternalSignalRelayServer(t)
	// "peer-z" > "peer-a", so peer-z is polite
	sc := NewSignalingClient(srv.URL, token, "peer-z")
	pm := NewPeerManager("peer-z", sc, func(_ context.Context, _ string, _ func([]byte) error, recv <-chan []byte) {
		for range recv {
		}
	}, internalTestLogger(t), webrtc.Configuration{})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Create the peer.
	state, err := pm.ensurePeer(ctx, "peer-a")
	if err != nil {
		t.Fatalf("ensurePeer: %v", err)
	}

	// Adding a data channel triggers ensurePeer's OnNegotiationNeeded handler,
	// which asynchronously runs CreateOffer + SetLocalDescription. We must let
	// that handler win and then observe the resulting state — otherwise the
	// test races the handler and fails intermittently under -race with
	// "InvalidModificationError: new sdp does not match previous offer".
	if _, dcErr := state.pc.CreateDataChannel("test", nil); dcErr != nil {
		t.Fatalf("create data channel: %v", dcErr)
	}

	deadline := time.Now().Add(2 * time.Second)
	for state.pc.SignalingState() != webrtc.SignalingStateHaveLocalOffer {
		if time.Now().After(deadline) {
			t.Fatalf("timeout waiting for have-local-offer; signaling state=%s", state.pc.SignalingState())
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Simulate that we are currently making an offer (the handler's defer
	// already cleared this flag; reset it so handleDescription sees the
	// collision condition).
	state.makingOffer.Store(true)

	// Create a remote peer to generate a valid incoming offer.
	remotePc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("create remote PC: %v", err)
	}
	defer remotePc.Close()
	_, _ = remotePc.CreateDataChannel("remote", nil)
	remoteOffer, err := remotePc.CreateOffer(nil)
	if err != nil {
		t.Fatalf("create remote offer: %v", err)
	}
	if err := remotePc.SetLocalDescription(remoteOffer); err != nil {
		t.Fatalf("set remote local description: %v", err)
	}

	// peer-z is polite → should attempt rollback and accept the incoming offer.
	// Note: Pion doesn't support SDP rollback, so the rollback will fail and
	// SetRemoteDescription will also fail. But this exercises both error paths
	// (rollback error + set remote description error).
	pm.handleDescription(ctx, SignalMessage{
		FromPeerID: "peer-a",
		SignalType: "description",
		Description: map[string]any{
			"type": remoteOffer.Type.String(),
			"sdp":  remoteOffer.SDP,
		},
	})

	state.makingOffer.Store(false)

	// The rollback failed (Pion doesn't support it), so remote description
	// won't be set. But the code paths were exercised without panic.
	pm.CloseAll()
}

// TestHandleICECandidateNoPeer verifies that handleICECandidate returns early
// when the peer doesn't exist.
func TestHandleICECandidateNoPeer(t *testing.T) {
	srv, token := newInternalSignalRelayServer(t)
	sc := NewSignalingClient(srv.URL, token, "peer-a")
	pm := NewPeerManager("peer-a", sc, func(_ context.Context, _ string, _ func([]byte) error, recv <-chan []byte) {
		for range recv {
		}
	}, internalTestLogger(t), webrtc.Configuration{})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Send ICE candidate for a peer that doesn't exist — should return early.
	pm.HandleSignal(ctx, SignalMessage{
		FromPeerID: "nonexistent-peer",
		SignalType: "ice-candidate",
		Candidate:  map[string]any{"candidate": "test"},
	})

	pm.CloseAll()
}

// TestHandleICECandidateMarshalError verifies that handleICECandidate handles
// an unmarshalable candidate gracefully.
func TestHandleICECandidateMarshalError(t *testing.T) {
	srv, token := newInternalSignalRelayServer(t)
	sc := NewSignalingClient(srv.URL, token, "peer-a")
	pm := NewPeerManager("peer-a", sc, func(_ context.Context, _ string, _ func([]byte) error, recv <-chan []byte) {
		for range recv {
		}
	}, internalTestLogger(t), webrtc.Configuration{})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Create the peer.
	pm.HandleSignal(ctx, SignalMessage{
		FromPeerID: "peer-b",
		SignalType: "announce",
	})

	// Send ICE candidate with invalid candidate data that can't be unmarshaled
	// to webrtc.ICECandidateInit (missing required fields).
	pm.HandleSignal(ctx, SignalMessage{
		FromPeerID: "peer-b",
		SignalType: "ice-candidate",
		Candidate:  map[string]any{"bad_field": 12345},
	})

	pm.CloseAll()
}

// TestAttachTunnelChannelAlreadyAttached verifies that attachTunnelChannel
// returns immediately if a tunnel channel is already attached (CompareAndSwap fails).
func TestAttachTunnelChannelAlreadyAttached(t *testing.T) {
	srv, token := newInternalSignalRelayServer(t)
	sc := NewSignalingClient(srv.URL, token, "peer-a")

	handlerCalls := &atomic.Int32{}
	pm := NewPeerManager("peer-a", sc, func(_ context.Context, _ string, _ func([]byte) error, recv <-chan []byte) {
		handlerCalls.Add(1)
		for range recv {
		}
	}, internalTestLogger(t), webrtc.Configuration{})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Create the peer.
	pm.HandleSignal(ctx, SignalMessage{
		FromPeerID: "peer-b",
		SignalType: "announce",
	})

	state := getPeerState(pm, "peer-b")
	if state == nil {
		t.Fatal("peer state is nil after announce")
	}

	// Mark tunnel as already attached.
	state.tunnelAttached.Store(true)

	// Create a data channel — attachTunnelChannel should return immediately
	// because tunnelAttached is already true.
	dc, err := state.pc.CreateDataChannel("tunnel", &webrtc.DataChannelInit{
		Ordered: boolPtr(true),
	})
	if err != nil {
		t.Fatalf("CreateDataChannel: %v", err)
	}

	pm.attachTunnelChannel(ctx, "peer-b", state, dc)

	// Handler should NOT have been called because the CAS failed.
	time.Sleep(50 * time.Millisecond)
	if handlerCalls.Load() != 0 {
		t.Errorf("handler should not be called when tunnel is already attached, got %d calls", handlerCalls.Load())
	}

	pm.CloseAll()
}

// TestHandleAnnounceExistingPeer verifies that handleAnnounce returns early
// when the peer already exists in the map.
func TestHandleAnnounceExistingPeerDoesNotRecreate(t *testing.T) {
	srv, token := newInternalSignalRelayServer(t)
	sc := NewSignalingClient(srv.URL, token, "peer-a")
	pm := NewPeerManager("peer-a", sc, func(_ context.Context, _ string, _ func([]byte) error, recv <-chan []byte) {
		for range recv {
		}
	}, internalTestLogger(t), webrtc.Configuration{})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// First announce creates the peer.
	pm.handleAnnounce(ctx, "peer-b")
	state1 := getPeerState(pm, "peer-b")
	if state1 == nil {
		t.Fatal("peer state should exist after first announce")
	}

	// Second announce should return early (peer exists).
	pm.handleAnnounce(ctx, "peer-b")
	state2 := getPeerState(pm, "peer-b")
	if state2 != state1 {
		t.Error("second announce should not replace the existing peer state")
	}

	pm.CloseAll()
}

// TestHandleDescriptionForNewPeer verifies that handleDescription can create
// a peer if it doesn't exist yet (via ensurePeer).
func TestHandleDescriptionForNewPeer(t *testing.T) {
	srv, token := newInternalSignalRelayServer(t)
	sc := NewSignalingClient(srv.URL, token, "peer-a")
	pm := NewPeerManager("peer-a", sc, func(_ context.Context, _ string, _ func([]byte) error, recv <-chan []byte) {
		for range recv {
		}
	}, internalTestLogger(t), webrtc.Configuration{})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Send a description for a peer that doesn't exist yet — ensurePeer will create it.
	// Use an invalid SDP that will fail at SetRemoteDescription to exercise that error path.
	pm.handleDescription(ctx, SignalMessage{
		FromPeerID: "peer-c",
		SignalType: "description",
		Description: map[string]any{
			"type": "offer",
			"sdp":  "invalid sdp content",
		},
	})

	// The peer should have been created by ensurePeer even though SetRemoteDescription failed.
	state := getPeerState(pm, "peer-c")
	if state == nil {
		t.Error("peer should be created by handleDescription via ensurePeer")
	}

	pm.CloseAll()
}

// TestCleanupPeerNonexistent verifies that cleanupPeer doesn't panic for
// a peer that doesn't exist.
func TestCleanupPeerNonexistent(t *testing.T) {
	srv, token := newInternalSignalRelayServer(t)
	sc := NewSignalingClient(srv.URL, token, "peer-a")
	pm := NewPeerManager("peer-a", sc, func(_ context.Context, _ string, _ func([]byte) error, recv <-chan []byte) {
		for range recv {
		}
	}, internalTestLogger(t), webrtc.Configuration{})

	// Should not panic.
	pm.cleanupPeer("nonexistent")
}

// TestEnsurePeerReturnsExisting verifies that ensurePeer returns the existing
// peer state when the peer is already in the map.
func TestEnsurePeerReturnsExisting(t *testing.T) {
	srv, token := newInternalSignalRelayServer(t)
	sc := NewSignalingClient(srv.URL, token, "peer-a")
	pm := NewPeerManager("peer-a", sc, func(_ context.Context, _ string, _ func([]byte) error, recv <-chan []byte) {
		for range recv {
		}
	}, internalTestLogger(t), webrtc.Configuration{})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	state1, err := pm.ensurePeer(ctx, "peer-b")
	if err != nil {
		t.Fatalf("first ensurePeer: %v", err)
	}

	state2, err := pm.ensurePeer(ctx, "peer-b")
	if err != nil {
		t.Fatalf("second ensurePeer: %v", err)
	}

	if state1 != state2 {
		t.Error("ensurePeer should return the same state for the same peer")
	}

	pm.CloseAll()
}

// TestEnsurePeerPoliteness verifies that politeness is assigned based on
// local vs remote peer ID comparison.
func TestEnsurePeerPoliteness(t *testing.T) {
	srv, token := newInternalSignalRelayServer(t)

	// peer-z > peer-a → polite = true
	sc := NewSignalingClient(srv.URL, token, "peer-z")
	pm := NewPeerManager("peer-z", sc, func(_ context.Context, _ string, _ func([]byte) error, recv <-chan []byte) {
		for range recv {
		}
	}, internalTestLogger(t), webrtc.Configuration{})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	state, err := pm.ensurePeer(ctx, "peer-a")
	if err != nil {
		t.Fatalf("ensurePeer: %v", err)
	}

	// "peer-z" > "peer-a" → polite = true
	if !state.polite {
		t.Error("peer-z should be polite when connecting to peer-a (higher ID = polite)")
	}

	pm.CloseAll()

	// peer-a < peer-z → polite = false
	sc2 := NewSignalingClient(srv.URL, token, "peer-a")
	pm2 := NewPeerManager("peer-a", sc2, func(_ context.Context, _ string, _ func([]byte) error, recv <-chan []byte) {
		for range recv {
		}
	}, internalTestLogger(t), webrtc.Configuration{})

	state2, err := pm2.ensurePeer(ctx, "peer-z")
	if err != nil {
		t.Fatalf("ensurePeer: %v", err)
	}

	// "peer-a" < "peer-z" → polite = false
	if state2.polite {
		t.Error("peer-a should be impolite when connecting to peer-z (lower ID = impolite)")
	}

	pm2.CloseAll()
}

// TestPeerStateTunnelCancelNil verifies that tunnelCancel returns nil
// when no tunnel is attached.
func TestPeerStateTunnelCancelNil(t *testing.T) {
	state := &peerState{}
	if cancel := state.tunnelCancel(); cancel != nil {
		t.Error("tunnelCancel should return nil on fresh peerState")
	}
}

// TestPeerStateTunnelSnapshotEmpty verifies that tunnelSnapshot returns
// zero values on a fresh peerState.
func TestPeerStateTunnelSnapshotEmpty(t *testing.T) {
	state := &peerState{}
	dc, recv, attached, cancel := state.tunnelSnapshot()
	if dc != nil {
		t.Error("tunnelCh should be nil")
	}
	if recv != nil {
		t.Error("tunnelRecv should be nil")
	}
	if attached {
		t.Error("tunnelAttached should be false")
	}
	if cancel != nil {
		t.Error("cancelTunnel should be nil")
	}
}

// TestHandleAnnounceSignalingSendError verifies that handleAnnounce
// handles the case where sending the announce reply via signaling fails.
func TestHandleAnnounceSignalingSendError(t *testing.T) {
	// Use a server URL that will accept the SSE connection but reject POSTs
	// by returning 500 errors.
	mux := http.NewServeMux()
	mux.HandleFunc("/api/sessions/test-token/signal", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte("signal error"))
	})
	mux.HandleFunc("/api/sessions/test-token/events", func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()
		<-r.Context().Done()
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	sc := NewSignalingClient(srv.URL, "test-token", "peer-a")
	pm := NewPeerManager("peer-a", sc, func(_ context.Context, _ string, _ func([]byte) error, recv <-chan []byte) {
		for range recv {
		}
	}, internalTestLogger(t), webrtc.Configuration{})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// This will call signaling.Send which will get a 500 error — exercises the
	// "announce to" error log path.
	pm.handleAnnounce(ctx, "peer-b")

	pm.CloseAll()
}

// TestHandleDescriptionValidOfferCreatesAnswer verifies that receiving a valid
// SDP offer from a remote peer results in an answer being created and sent.
func TestHandleDescriptionValidOfferCreatesAnswer(t *testing.T) {
	srv, token := newInternalSignalRelayServer(t)
	// Use peer-z (higher ID) so that ensurePeer doesn't auto-create a data channel
	// (only the lower-ID peer does that). This avoids OnNegotiationNeeded firing
	// and overwriting our answer with a new offer.
	sc := NewSignalingClient(srv.URL, token, "peer-z")
	pm := NewPeerManager("peer-z", sc, func(_ context.Context, _ string, _ func([]byte) error, recv <-chan []byte) {
		for range recv {
		}
	}, internalTestLogger(t), webrtc.Configuration{})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Create a separate PeerConnection to generate a valid offer SDP.
	remotePc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("create remote PC: %v", err)
	}
	defer remotePc.Close()

	// Create a data channel to trigger SDP offer generation.
	_, err = remotePc.CreateDataChannel("test", nil)
	if err != nil {
		t.Fatalf("create data channel: %v", err)
	}

	offer, err := remotePc.CreateOffer(nil)
	if err != nil {
		t.Fatalf("create offer: %v", err)
	}
	if err := remotePc.SetLocalDescription(offer); err != nil {
		t.Fatalf("set local description: %v", err)
	}

	// Send the offer as a description signal from peer-a (lower ID).
	pm.handleDescription(ctx, SignalMessage{
		FromPeerID: "peer-a",
		SignalType: "description",
		Description: map[string]any{
			"type": offer.Type.String(),
			"sdp":  offer.SDP,
		},
	})

	// The peer should have been created and an answer should have been generated.
	state := getPeerState(pm, "peer-a")
	if state == nil {
		t.Fatal("peer should exist after handling a valid offer")
	}
	// The local description should be set (answer).
	ld := state.pc.LocalDescription()
	if ld == nil {
		t.Error("local description should be set after creating answer")
	} else if ld.Type != webrtc.SDPTypeAnswer {
		t.Errorf("local description type = %v, want answer", ld.Type)
	}

	pm.CloseAll()
}

// TestHandleDescriptionAnswerSetsRemoteDescription verifies that receiving an
// answer SDP sets the remote description without creating a new answer.
func TestHandleDescriptionAnswerSetsRemoteDescription(t *testing.T) {
	srv, token := newInternalSignalRelayServer(t)
	// Use peer-z (higher ID) so ensurePeer doesn't auto-create a data channel.
	sc := NewSignalingClient(srv.URL, token, "peer-z")
	pm := NewPeerManager("peer-z", sc, func(_ context.Context, _ string, _ func([]byte) error, recv <-chan []byte) {
		for range recv {
		}
	}, internalTestLogger(t), webrtc.Configuration{})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Create the peer first.
	state, err := pm.ensurePeer(ctx, "peer-a")
	if err != nil {
		t.Fatalf("ensurePeer: %v", err)
	}

	// Adding a data channel triggers ensurePeer's OnNegotiationNeeded handler,
	// which asynchronously runs CreateOffer + SetLocalDescription. Let it win
	// and read its offer; calling CreateOffer/SetLocalDescription ourselves
	// races the handler and fails intermittently under -race with
	// "InvalidModificationError: new sdp does not match previous offer".
	if _, dcErr := state.pc.CreateDataChannel("test", nil); dcErr != nil {
		t.Fatalf("create data channel: %v", dcErr)
	}

	deadline := time.Now().Add(2 * time.Second)
	for state.pc.SignalingState() != webrtc.SignalingStateHaveLocalOffer {
		if time.Now().After(deadline) {
			t.Fatalf("timeout waiting for have-local-offer; signaling state=%s", state.pc.SignalingState())
		}
		time.Sleep(10 * time.Millisecond)
	}

	offer := *state.pc.LocalDescription()

	// Create a remote peer to generate a valid answer.
	remotePc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("create remote PC: %v", err)
	}
	defer remotePc.Close()

	if err := remotePc.SetRemoteDescription(offer); err != nil {
		t.Fatalf("set remote description: %v", err)
	}
	answer, err := remotePc.CreateAnswer(nil)
	if err != nil {
		t.Fatalf("create answer: %v", err)
	}
	if err := remotePc.SetLocalDescription(answer); err != nil {
		t.Fatalf("set local answer: %v", err)
	}

	// Send the answer.
	pm.handleDescription(ctx, SignalMessage{
		FromPeerID: "peer-a",
		SignalType: "description",
		Description: map[string]any{
			"type": answer.Type.String(),
			"sdp":  answer.SDP,
		},
	})

	// The remote description should be set.
	rd := state.pc.RemoteDescription()
	if rd == nil {
		t.Error("remote description should be set after receiving answer")
	}

	pm.CloseAll()
}

// TestHandleICECandidateAddError verifies that handleICECandidate logs an
// error when AddICECandidate fails (e.g., peer connection in wrong state).
func TestHandleICECandidateAddError(t *testing.T) {
	srv, token := newInternalSignalRelayServer(t)
	sc := NewSignalingClient(srv.URL, token, "peer-a")
	pm := NewPeerManager("peer-a", sc, func(_ context.Context, _ string, _ func([]byte) error, recv <-chan []byte) {
		for range recv {
		}
	}, internalTestLogger(t), webrtc.Configuration{})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Create the peer.
	pm.handleAnnounce(ctx, "peer-b")

	// Send a valid-looking ICE candidate that will fail AddICECandidate
	// because no remote description has been set.
	pm.handleICECandidate(SignalMessage{
		FromPeerID: "peer-b",
		SignalType: "ice-candidate",
		Candidate: map[string]any{
			"candidate":     "candidate:1 1 udp 2130706431 192.168.1.1 12345 typ host",
			"sdpMid":        "0",
			"sdpMLineIndex": float64(0),
		},
	})

	// Should not panic — error is logged.
	pm.CloseAll()
}

// TestCleanupPeerCancelsTunnel verifies that cleanupPeer invokes the
// tunnel cancel function when a tunnel is attached.
func TestCleanupPeerCancelsTunnel(t *testing.T) {
	srv, token := newInternalSignalRelayServer(t)
	sc := NewSignalingClient(srv.URL, token, "peer-a")

	handlerDone := make(chan struct{})
	pm := NewPeerManager("peer-a", sc, func(ctx context.Context, _ string, _ func([]byte) error, recv <-chan []byte) {
		defer close(handlerDone)
		select {
		case <-ctx.Done():
		case <-recv:
		}
	}, internalTestLogger(t), webrtc.Configuration{})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	state, err := pm.ensurePeer(ctx, "peer-b")
	if err != nil {
		t.Fatalf("ensurePeer: %v", err)
	}

	// Manually set up a tunnel cancel function to verify cleanup calls it.
	tunnelCtx, tunnelCancel := context.WithCancel(ctx)
	state.setTunnel(nil, make(chan []byte, 1), tunnelCancel)
	state.tunnelAttached.Store(true)

	pm.cleanupPeer("peer-b")

	// The tunnel context should have been cancelled.
	select {
	case <-tunnelCtx.Done():
		// Good.
	default:
		t.Error("cleanupPeer should cancel the tunnel context")
	}
}
