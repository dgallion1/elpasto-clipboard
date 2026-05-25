package api

import (
	"context"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

type plausibleConfig struct {
	scriptURL string
	eventURL  string
}

func newPlausibleEventHandler(cfg plausibleConfig, client *http.Client) http.Handler {
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if cfg.eventURL == "" {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		upstreamReq, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.eventURL, r.Body)
		if err != nil {
			http.Error(w, "bad upstream url", http.StatusInternalServerError)
			return
		}
		if ct := r.Header.Get("Content-Type"); ct != "" {
			upstreamReq.Header.Set("Content-Type", ct)
		}
		if ua := r.Header.Get("User-Agent"); ua != "" {
			upstreamReq.Header.Set("User-Agent", ua)
		}
		upstreamReq.Header.Set("X-Forwarded-Proto", plausibleClientProto(r))
		upstreamReq.Header.Set("X-Forwarded-Host", r.Host)
		upstreamReq.Header.Set("X-Forwarded-For", plausibleClientIP(r))

		resp, err := client.Do(upstreamReq)
		if err != nil {
			http.Error(w, "upstream unreachable", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()

		if ct := resp.Header.Get("Content-Type"); ct != "" {
			w.Header().Set("Content-Type", ct)
		}
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, resp.Body)
	})
}

func plausibleClientIP(r *http.Request) string {
	if cf := strings.TrimSpace(r.Header.Get("CF-Connecting-IP")); cf != "" {
		return cf
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if comma := strings.IndexByte(xff, ','); comma > 0 {
			return strings.TrimSpace(xff[:comma])
		}
		return strings.TrimSpace(xff)
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

func plausibleClientProto(r *http.Request) string {
	if p := r.Header.Get("X-Forwarded-Proto"); p != "" {
		return p
	}
	if r.TLS != nil {
		return "https"
	}
	return "http"
}

func newPlausibleScriptHandler(cfg plausibleConfig, client *http.Client) http.Handler {
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if cfg.scriptURL == "" {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		upstreamReq, err := http.NewRequestWithContext(ctx, http.MethodGet, cfg.scriptURL, nil)
		if err != nil {
			http.Error(w, "bad upstream url", http.StatusInternalServerError)
			return
		}
		if ua := r.Header.Get("User-Agent"); ua != "" {
			upstreamReq.Header.Set("User-Agent", ua)
		}
		upstreamReq.Header.Set("Accept", "*/*")

		resp, err := client.Do(upstreamReq)
		if err != nil {
			http.Error(w, "upstream unreachable", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()

		if ct := resp.Header.Get("Content-Type"); ct != "" {
			w.Header().Set("Content-Type", ct)
		} else {
			w.Header().Set("Content-Type", "application/javascript")
		}
		w.Header().Set("Cache-Control", "public, max-age=21600")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.WriteHeader(resp.StatusCode)
		if r.Method == http.MethodGet {
			_, _ = io.Copy(w, resp.Body)
		}
	})
}
