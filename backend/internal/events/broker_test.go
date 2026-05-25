package events

import (
	"reflect"
	"testing"
)

func TestSubscribePublishAndUnsubscribe(t *testing.T) {
	broker := New()
	ch, unsubscribe := broker.Subscribe("token-123456789", "")

	broker.Publish("token-123456789", "clip:created", map[string]string{"id": "1"})
	event := <-ch
	if event.Name != "clip:created" {
		t.Fatalf("event.Name = %q", event.Name)
	}

	unsubscribe()
	unsubscribe()
	if _, ok := <-ch; ok {
		t.Fatal("expected channel to be closed after unsubscribe")
	}
}

func TestPublishDropsSlowConsumersAndTruncatesToken(t *testing.T) {
	broker := New()
	_, _ = broker.Subscribe("verylongtoken", "")

	for i := 0; i < 17; i++ {
		broker.Publish("verylongtoken", "ping", i)
	}
	broker.Publish("verylongtoken", "dropped", "overflow")

	if got := truncateToken("short"); got != "short" {
		t.Fatalf("truncateToken short = %q", got)
	}
	if got := truncateToken("123456789"); got != "12345678" {
		t.Fatalf("truncateToken long = %q", got)
	}
}

func TestSubscribeWithIPTracksConnections(t *testing.T) {
	broker := New()
	_, unsub1 := broker.Subscribe("token-aaa", "10.0.0.1")
	_, unsub2 := broker.Subscribe("token-aaa", "10.0.0.2")
	_, unsub3 := broker.Subscribe("token-bbb", "10.0.0.1")

	conns := broker.ConnectionsBySession()
	if len(conns) != 2 {
		t.Fatalf("expected 2 sessions, got %d", len(conns))
	}
	if got := conns["token-aaa"]; !reflect.DeepEqual(got, []string{"10.0.0.1", "10.0.0.2"}) {
		t.Fatalf("token-aaa IPs = %v", got)
	}
	if got := conns["token-bbb"]; !reflect.DeepEqual(got, []string{"10.0.0.1"}) {
		t.Fatalf("token-bbb IPs = %v", got)
	}

	total, sessions := broker.SubscriberStats()
	if total != 3 {
		t.Errorf("total SSE connections: got %d, want 3", total)
	}
	if sessions != 2 {
		t.Errorf("sessions with viewers: got %d, want 2", sessions)
	}

	unsub1()
	unsub2()
	conns = broker.ConnectionsBySession()
	if _, ok := conns["token-aaa"]; ok {
		t.Errorf("expected token-aaa to be removed after last unsubscribe, got %v", conns["token-aaa"])
	}
	if got := conns["token-bbb"]; !reflect.DeepEqual(got, []string{"10.0.0.1"}) {
		t.Errorf("token-bbb IPs = %v", got)
	}

	unsub3()
}

func TestConnectionsBySessionDeduplicatesIPs(t *testing.T) {
	broker := New()
	_, unsub1 := broker.Subscribe("token-x", "10.0.0.1")
	_, unsub2 := broker.Subscribe("token-x", "10.0.0.1")

	conns := broker.ConnectionsBySession()
	if got := conns["token-x"]; !reflect.DeepEqual(got, []string{"10.0.0.1"}) {
		t.Fatalf("token-x IPs = %v", got)
	}

	total, sessions := broker.SubscriberStats()
	if total != 2 {
		t.Errorf("total should count raw connections, got %d", total)
	}
	if sessions != 1 {
		t.Errorf("active sessions = %d, want 1", sessions)
	}

	unsub1()
	unsub2()
}

func TestPublishToNonexistentToken(t *testing.T) {
	broker := New()
	// Should not panic when publishing to a token with no subscribers.
	broker.Publish("nonexistent-token", "clip:created", "data")
}

func TestSubscribeReceivesMultipleEvents(t *testing.T) {
	broker := New()
	ch, unsub := broker.Subscribe("multi-token", "10.0.0.1")
	defer unsub()

	broker.Publish("multi-token", "clip:created", "a")
	broker.Publish("multi-token", "clip:deleted", "b")
	broker.Publish("multi-token", "session:expired", "c")

	events := make([]Event, 0, 3)
	for i := 0; i < 3; i++ {
		events = append(events, <-ch)
	}

	if events[0].Name != "clip:created" || events[1].Name != "clip:deleted" || events[2].Name != "session:expired" {
		t.Fatalf("unexpected event sequence: %v", events)
	}
}

func TestSubscribeSessionIsolation(t *testing.T) {
	broker := New()
	chA, unsubA := broker.Subscribe("token-a", "10.0.0.1")
	chB, unsubB := broker.Subscribe("token-b", "10.0.0.2")
	defer unsubA()
	defer unsubB()

	broker.Publish("token-a", "clip:created", "for-a")

	// token-a should receive the event.
	event := <-chA
	if event.Data != "for-a" {
		t.Fatalf("expected 'for-a', got %v", event.Data)
	}

	// token-b should not have received anything.
	select {
	case ev := <-chB:
		t.Fatalf("token-b should not receive events for token-a, got %v", ev)
	default:
		// Good - no event.
	}
}

func TestConnectionsBySessionEmptyIPsFiltered(t *testing.T) {
	broker := New()
	// Subscribe with empty IP.
	_, unsub1 := broker.Subscribe("token-empty-ip", "")
	_, unsub2 := broker.Subscribe("token-empty-ip", "10.0.0.1")
	defer unsub1()
	defer unsub2()

	conns := broker.ConnectionsBySession()
	ips := conns["token-empty-ip"]
	if len(ips) != 1 || ips[0] != "10.0.0.1" {
		t.Fatalf("expected only non-empty IP, got %v", ips)
	}
}

func TestConnectionsBySessionAllEmptyIPs(t *testing.T) {
	broker := New()
	_, unsub := broker.Subscribe("token-all-empty", "")
	defer unsub()

	conns := broker.ConnectionsBySession()
	ips := conns["token-all-empty"]
	if len(ips) != 0 {
		t.Fatalf("expected empty IP list, got %v", ips)
	}
}

func TestSubscriberStatsEmpty(t *testing.T) {
	broker := New()
	total, sessions := broker.SubscriberStats()
	if total != 0 || sessions != 0 {
		t.Fatalf("empty broker stats: total=%d, sessions=%d", total, sessions)
	}
}

func TestMultipleSubscribersReceiveEvent(t *testing.T) {
	broker := New()
	ch1, unsub1 := broker.Subscribe("shared-token", "10.0.0.1")
	ch2, unsub2 := broker.Subscribe("shared-token", "10.0.0.2")
	defer unsub1()
	defer unsub2()

	broker.Publish("shared-token", "test-event", "payload")

	ev1 := <-ch1
	ev2 := <-ch2
	if ev1.Name != "test-event" || ev2.Name != "test-event" {
		t.Fatalf("both subscribers should receive the event, got %v and %v", ev1, ev2)
	}
}

func TestUnsubscribeAfterTokenMapRemoved(t *testing.T) {
	broker := New()
	_, unsub := broker.Subscribe("removed-token", "10.0.0.1")

	// Manually remove the token map entry to simulate the !ok branch.
	broker.mu.Lock()
	delete(broker.subs, "removed-token")
	broker.mu.Unlock()

	// Unsubscribe should not panic when the token map is already gone.
	unsub()
}

func TestUnsubscribeCleanupEmptiesSession(t *testing.T) {
	broker := New()
	_, unsub := broker.Subscribe("cleanup-token", "10.0.0.1")

	// Before unsubscribe, session should exist.
	_, sessions := broker.SubscriberStats()
	if sessions != 1 {
		t.Fatalf("expected 1 session, got %d", sessions)
	}

	unsub()

	// After unsubscribing the only subscriber, session map entry should be removed.
	_, sessions = broker.SubscriberStats()
	if sessions != 0 {
		t.Fatalf("expected 0 sessions after last unsub, got %d", sessions)
	}

	// ConnectionsBySession should also reflect removal.
	conns := broker.ConnectionsBySession()
	if _, ok := conns["cleanup-token"]; ok {
		t.Fatal("session should be removed from connections map")
	}
}
