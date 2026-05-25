package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Port                        int
	DataDir                     string
	DownloadsDir                string
	SessionExpiryHours          int
	MaxClipBytes                int64
	MaxSessionBytes             int64
	MaxClipsPerZone             int
	RateLimitCreatePerHour      int
	RateLimitBatchCreatePerHour int
	RateLimitLookupsPerMinute   int
	RateLimitSignalsPerMinute   int
	RateLimitUploadsPerMinute   int
	CleanupInterval             time.Duration
	TurnSecret                  string
	TurnServer                  string
	EnableBatchSessionCreate           bool
	TrustProxyHeaders                  bool
	GoogleOAuthClientID                string
	GoogleOAuthClientSecret            string
	TunnelAuthSecret                   string
	TunnelAuthAllowedEmails            []string
	TunnelAuthAllowedDomains           []string
	RateLimitTunnelAuthStartsPerHour    int
	RateLimitTunnelAuthCallbacksPerHour int
	TunnelBaseURL                       string
	StatsDashboardKey                   string
	PlausibleScriptURL string
	PlausibleEventURL  string
}

func FromEnv() Config {
	wd, err := os.Getwd()
	if err != nil {
		wd = "."
	}

	dataDir := getenv("DATA_DIR", filepath.Join(wd, "data"))
	return Config{
		Port:                        getenvInt("PORT", 3000),
		DataDir:                     dataDir,
		DownloadsDir:                getenv("DOWNLOADS_DIR", filepath.Join(wd, "downloads")),
		SessionExpiryHours:          getenvInt("SESSION_EXPIRY_HOURS", 24),
		MaxClipBytes:                int64(getenvInt("MAX_CLIP_BYTES", 512*1024)),
		MaxSessionBytes:             int64(getenvInt("MAX_SESSION_BYTES", 100*1024*1024)),
		MaxClipsPerZone:             getenvInt("MAX_CLIPS_PER_ZONE", 100),
		RateLimitCreatePerHour:      getenvInt("RATE_LIMIT_CREATE_PER_HOUR", 20),
		RateLimitBatchCreatePerHour: getenvInt("RATE_LIMIT_BATCH_CREATE_PER_HOUR", 60),
		RateLimitLookupsPerMinute:   getenvInt("RATE_LIMIT_LOOKUPS_PER_MINUTE", 10),
		RateLimitSignalsPerMinute:   getenvInt("RATE_LIMIT_SIGNALS_PER_MINUTE", 240),
		RateLimitUploadsPerMinute:   getenvInt("RATE_LIMIT_UPLOADS_PER_MINUTE", 30),
		CleanupInterval:             time.Duration(getenvInt("CLEANUP_INTERVAL_MS", 60*60*1000)) * time.Millisecond,
		TurnSecret:                  getenv("TURN_SECRET", ""),
		TurnServer:                  getenv("TURN_SERVER", ""),
		EnableBatchSessionCreate:            getenvBool("ENABLE_BATCH_SESSION_CREATE", false),
		TrustProxyHeaders:                   getenvBool("TRUST_PROXY_HEADERS", false),
		GoogleOAuthClientID:                 getenv("GOOGLE_OAUTH_CLIENT_ID", ""),
		GoogleOAuthClientSecret:             getenv("GOOGLE_OAUTH_CLIENT_SECRET", ""),
		TunnelAuthSecret:                    getenv("TUNNEL_AUTH_SECRET", ""),
		TunnelAuthAllowedEmails:             parseCSV(getenv("TUNNEL_AUTH_ALLOWED_EMAILS", "")),
		TunnelAuthAllowedDomains:            parseCSV(getenv("TUNNEL_AUTH_ALLOWED_DOMAINS", "")),
		RateLimitTunnelAuthStartsPerHour:    getenvInt("RATE_LIMIT_TUNNEL_AUTH_STARTS_PER_HOUR", 10),
		RateLimitTunnelAuthCallbacksPerHour: getenvInt("RATE_LIMIT_TUNNEL_AUTH_CALLBACKS_PER_HOUR", 30),
		TunnelBaseURL:                       getenv("TUNNEL_BASE_URL", ""),
		StatsDashboardKey:                   getenv("STATS_DASHBOARD_KEY", ""),
		PlausibleScriptURL: os.Getenv("PLAUSIBLE_SCRIPT_URL"),
		PlausibleEventURL:  getenv("PLAUSIBLE_EVENT_URL", ""),
	}
}

func getenv(key, fallback string) string {
	if value, ok := os.LookupEnv(key); ok && value != "" {
		return value
	}
	return fallback
}

func getenvInt(key string, fallback int) int {
	value, ok := os.LookupEnv(key)
	if !ok || value == "" {
		return fallback
	}

	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}

	return parsed
}

// TunnelAuthEnabled returns true if Google OAuth tunnel auth is configured.
func (c Config) TunnelAuthEnabled() bool {
	return c.GoogleOAuthClientID != ""
}

// ValidateTunnelAuth checks that tunnel auth config is complete when any
// tunnel-auth env var is set. Returns an error describing what's missing.
func (c Config) ValidateTunnelAuth() error {
	// If the primary toggle is off, nothing to validate.
	if c.GoogleOAuthClientID == "" {
		// But check that no other tunnel-auth vars were set (half-configured).
		if c.GoogleOAuthClientSecret != "" || c.TunnelAuthSecret != "" ||
			len(c.TunnelAuthAllowedEmails) > 0 || len(c.TunnelAuthAllowedDomains) > 0 {
			return fmt.Errorf("tunnel auth partially configured: GOOGLE_OAUTH_CLIENT_ID is required when other TUNNEL_AUTH_* or GOOGLE_OAUTH_* vars are set")
		}
		return nil
	}
	if c.GoogleOAuthClientSecret == "" {
		return fmt.Errorf("tunnel auth: GOOGLE_OAUTH_CLIENT_SECRET is required when GOOGLE_OAUTH_CLIENT_ID is set")
	}
	if c.TunnelAuthSecret == "" {
		return fmt.Errorf("tunnel auth: TUNNEL_AUTH_SECRET is required when GOOGLE_OAUTH_CLIENT_ID is set")
	}
	if len(c.TunnelAuthAllowedEmails) == 0 && len(c.TunnelAuthAllowedDomains) == 0 {
		return fmt.Errorf("tunnel auth: at least one of TUNNEL_AUTH_ALLOWED_EMAILS or TUNNEL_AUTH_ALLOWED_DOMAINS is required")
	}
	return nil
}

// ValidateTunnelBaseURL checks that TUNNEL_BASE_URL is a valid absolute HTTP(S) URL when set.
func (c Config) ValidateTunnelBaseURL() error {
	if c.TunnelBaseURL == "" {
		return nil
	}
	if !strings.HasPrefix(c.TunnelBaseURL, "http://") && !strings.HasPrefix(c.TunnelBaseURL, "https://") {
		return fmt.Errorf("TUNNEL_BASE_URL must start with http:// or https://, got %q", c.TunnelBaseURL)
	}
	return nil
}

// parseCSV splits a comma-separated string into trimmed, lowercased, non-empty values.
func parseCSV(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	var result []string
	for _, p := range parts {
		p = strings.ToLower(strings.TrimSpace(p))
		if p != "" {
			result = append(result, p)
		}
	}
	return result
}

func getenvBool(key string, fallback bool) bool {
	value, ok := os.LookupEnv(key)
	if !ok || value == "" {
		return fallback
	}

	switch value {
	case "1", "true", "TRUE", "True", "yes", "YES", "on", "ON":
		return true
	case "0", "false", "FALSE", "False", "no", "NO", "off", "OFF":
		return false
	default:
		return fallback
	}
}
