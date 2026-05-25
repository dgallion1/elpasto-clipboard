package events

import (
	"log"
	"sort"
	"sync"
)

type Event struct {
	Name string
	Data any
}

type Broker struct {
	mu   sync.RWMutex
	subs map[string]map[chan Event]string
}

func New() *Broker {
	return &Broker{
		subs: make(map[string]map[chan Event]string),
	}
}

func (b *Broker) Subscribe(token, ip string) (<-chan Event, func()) {
	ch := make(chan Event, 16)

	b.mu.Lock()
	if _, ok := b.subs[token]; !ok {
		b.subs[token] = make(map[chan Event]string)
	}
	b.subs[token][ch] = ip
	b.mu.Unlock()

	var once sync.Once
	unsubscribe := func() {
		once.Do(func() {
			b.mu.Lock()
			defer b.mu.Unlock()

			tokenSubs, ok := b.subs[token]
			if !ok {
				return
			}
			delete(tokenSubs, ch)
			if len(tokenSubs) == 0 {
				delete(b.subs, token)
			}
			close(ch)
		})
	}

	return ch, unsubscribe
}

// ConnectionsBySession returns token -> sorted unique subscriber IPs.
func (b *Broker) ConnectionsBySession() map[string][]string {
	b.mu.RLock()
	defer b.mu.RUnlock()

	result := make(map[string][]string, len(b.subs))
	for token, tokenSubs := range b.subs {
		seen := make(map[string]struct{}, len(tokenSubs))
		for _, ip := range tokenSubs {
			if ip == "" {
				continue
			}
			seen[ip] = struct{}{}
		}

		ips := make([]string, 0, len(seen))
		for ip := range seen {
			ips = append(ips, ip)
		}
		sort.Strings(ips)
		result[token] = ips
	}

	return result
}

// SubscriberStats returns total live SSE subscriptions and active session count.
func (b *Broker) SubscriberStats() (totalConns int, activeSessions int) {
	b.mu.RLock()
	defer b.mu.RUnlock()

	for _, tokenSubs := range b.subs {
		totalConns += len(tokenSubs)
	}

	return totalConns, len(b.subs)
}

// truncateToken returns the first 8 characters of a token for safe logging.
func truncateToken(token string) string {
	if len(token) <= 8 {
		return token
	}
	return token[:8]
}

func (b *Broker) Publish(token string, name string, data any) {
	b.mu.RLock()
	tokenSubs := b.subs[token]
	subscribers := make([]chan Event, 0, len(tokenSubs))
	for subscriber := range tokenSubs {
		subscribers = append(subscribers, subscriber)
	}
	b.mu.RUnlock()

	event := Event{Name: name, Data: data}
	for _, subscriber := range subscribers {
		select {
		case subscriber <- event:
		default:
			log.Printf("events: dropped %s event for token %s... (slow consumer)", name, truncateToken(token))
		}
	}
}
