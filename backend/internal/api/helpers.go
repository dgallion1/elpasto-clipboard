package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func parseBooleanField(value any) (bool, bool) {
	switch typed := value.(type) {
	case nil:
		return false, true
	case bool:
		return typed, true
	case string:
		switch typed {
		case "true":
			return true, true
		case "false", "":
			return false, true
		default:
			return false, false
		}
	default:
		return false, false
	}
}

func parseIntegerField(value any) (int, bool) {
	switch typed := value.(type) {
	case nil:
		return 0, false
	case int:
		return typed, true
	case int64:
		return int(typed), true
	case float64:
		if typed != float64(int(typed)) {
			return 0, false
		}
		return int(typed), true
	case json.Number:
		parsed, err := typed.Int64()
		if err != nil {
			return 0, false
		}
		return int(parsed), true
	case string:
		if strings.TrimSpace(typed) == "" {
			return 0, false
		}
		parsed, err := strconv.Atoi(typed)
		if err != nil {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	headers := w.Header()
	headers.Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func sleepWithContext(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()

	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// clientIP extracts the client IP for rate limiting.
// Prefers CF-Connecting-IP (set by Cloudflare), then X-Forwarded-For.
func clientIP(r *http.Request, trustProxyHeaders bool) string {
	if trustProxyHeaders {
		if ip := r.Header.Get("CF-Connecting-IP"); ip != "" {
			return ip
		}

		forwardedFor := r.Header.Get("X-Forwarded-For")
		if forwardedFor != "" {
			parts := strings.Split(forwardedFor, ",")
			if ip := strings.TrimSpace(parts[0]); ip != "" {
				return ip
			}
		}
	}

	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil && host != "" {
		return host
	}

	return "unknown"
}

func decodeJSONBody(w http.ResponseWriter, r *http.Request, limit int64, dest any) error {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	decoder := json.NewDecoder(r.Body)
	return decoder.Decode(dest)
}

func writeSSEEvent(w io.Writer, name string, data any) error {
	payload, err := json.Marshal(data)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "event: %s\n", name); err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "data: %s\n\n", payload); err != nil {
		return err
	}
	return nil
}
