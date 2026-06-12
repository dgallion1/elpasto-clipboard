package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestGetenv(t *testing.T) {
	t.Setenv("CONFIG_TEST_VALUE", "custom")
	if got := getenv("CONFIG_TEST_VALUE", "fallback"); got != "custom" {
		t.Fatalf("getenv returned %q", got)
	}

	t.Setenv("CONFIG_TEST_EMPTY", "")
	if got := getenv("CONFIG_TEST_EMPTY", "fallback"); got != "fallback" {
		t.Fatalf("getenv empty returned %q", got)
	}

	if got := getenv("CONFIG_TEST_MISSING", "fallback"); got != "fallback" {
		t.Fatalf("getenv missing returned %q", got)
	}
}

func TestGetenvInt(t *testing.T) {
	t.Setenv("CONFIG_TEST_INT", "42")
	if got := getenvInt("CONFIG_TEST_INT", 7); got != 42 {
		t.Fatalf("getenvInt valid = %d", got)
	}

	t.Setenv("CONFIG_TEST_INT_EMPTY", "")
	if got := getenvInt("CONFIG_TEST_INT_EMPTY", 7); got != 7 {
		t.Fatalf("getenvInt empty = %d", got)
	}

	t.Setenv("CONFIG_TEST_INT_BAD", "bad")
	if got := getenvInt("CONFIG_TEST_INT_BAD", 7); got != 7 {
		t.Fatalf("getenvInt invalid = %d", got)
	}

	if got := getenvInt("CONFIG_TEST_INT_MISSING", 7); got != 7 {
		t.Fatalf("getenvInt missing = %d", got)
	}
}

func TestFromEnvSetsDownloadsDir(t *testing.T) {
	t.Run("explicit DOWNLOADS_DIR wins", func(t *testing.T) {
		dir := t.TempDir()
		t.Setenv("DOWNLOADS_DIR", dir)
		cfg := FromEnv()
		if cfg.DownloadsDir != dir {
			t.Fatalf("DownloadsDir = %q, want %q", cfg.DownloadsDir, dir)
		}
	})

	t.Run("fallback default is cwd/downloads", func(t *testing.T) {
		t.Setenv("DOWNLOADS_DIR", "")
		wd, _ := os.Getwd()
		cfg := FromEnv()
		want := filepath.Join(wd, "downloads")
		if cfg.DownloadsDir != want {
			t.Fatalf("DownloadsDir = %q, want %q", cfg.DownloadsDir, want)
		}
	})
}

func TestFromEnv(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DATA_DIR", dir)
	t.Setenv("PORT", "4321")
	t.Setenv("SESSION_EXPIRY_HOURS", "12")
	t.Setenv("MAX_CLIP_BYTES", "99")
	t.Setenv("MAX_SESSION_BYTES", "199")
	t.Setenv("MAX_CLIPS_PER_ZONE", "9")
	t.Setenv("RATE_LIMIT_CREATE_PER_HOUR", "5")
	t.Setenv("RATE_LIMIT_BATCH_CREATE_PER_HOUR", "10")
	t.Setenv("RATE_LIMIT_LOOKUPS_PER_MINUTE", "6")
	t.Setenv("RATE_LIMIT_UPLOADS_PER_MINUTE", "7")
	t.Setenv("CLEANUP_INTERVAL_MS", "2500")

	cfg := FromEnv()
	if cfg.DataDir != dir {
		t.Fatalf("DataDir = %q", cfg.DataDir)
	}
	if cfg.Port != 4321 || cfg.SessionExpiryHours != 12 || cfg.MaxClipBytes != 99 || cfg.MaxSessionBytes != 199 {
		t.Fatalf("unexpected numeric config: %+v", cfg)
	}
	if cfg.MaxClipsPerZone != 9 || cfg.RateLimitCreatePerHour != 5 || cfg.RateLimitBatchCreatePerHour != 10 || cfg.RateLimitLookupsPerMinute != 6 || cfg.RateLimitUploadsPerMinute != 7 {
		t.Fatalf("unexpected rate config: %+v", cfg)
	}
	if cfg.CleanupInterval != 2500*time.Millisecond {
		t.Fatalf("CleanupInterval = %s", cfg.CleanupInterval)
	}
}

func TestGetenvBool(t *testing.T) {
	t.Run("missing returns fallback", func(t *testing.T) {
		if got := getenvBool("CONFIG_TEST_BOOL_MISSING", true); !got {
			t.Fatal("expected true fallback")
		}
		if got := getenvBool("CONFIG_TEST_BOOL_MISSING", false); got {
			t.Fatal("expected false fallback")
		}
	})

	t.Run("empty returns fallback", func(t *testing.T) {
		t.Setenv("CONFIG_TEST_BOOL", "")
		if got := getenvBool("CONFIG_TEST_BOOL", true); !got {
			t.Fatal("expected true fallback for empty")
		}
	})

	for _, v := range []string{"1", "true", "TRUE", "True", "yes", "YES", "on", "ON"} {
		t.Run("true: "+v, func(t *testing.T) {
			t.Setenv("CONFIG_TEST_BOOL", v)
			if !getenvBool("CONFIG_TEST_BOOL", false) {
				t.Fatalf("%q should be true", v)
			}
		})
	}

	for _, v := range []string{"0", "false", "FALSE", "False", "no", "NO", "off", "OFF"} {
		t.Run("false: "+v, func(t *testing.T) {
			t.Setenv("CONFIG_TEST_BOOL", v)
			if getenvBool("CONFIG_TEST_BOOL", true) {
				t.Fatalf("%q should be false", v)
			}
		})
	}

	t.Run("invalid returns fallback", func(t *testing.T) {
		t.Setenv("CONFIG_TEST_BOOL", "maybe")
		if got := getenvBool("CONFIG_TEST_BOOL", true); !got {
			t.Fatal("invalid should return true fallback")
		}
		if got := getenvBool("CONFIG_TEST_BOOL", false); got {
			t.Fatal("invalid should return false fallback")
		}
	})
}

func TestParseCSV(t *testing.T) {
	t.Run("empty string", func(t *testing.T) {
		if got := parseCSV(""); got != nil {
			t.Fatalf("expected nil, got %v", got)
		}
	})

	t.Run("single value", func(t *testing.T) {
		got := parseCSV("Alice@Example.COM")
		if len(got) != 1 || got[0] != "alice@example.com" {
			t.Fatalf("got %v", got)
		}
	})

	t.Run("multiple values with whitespace", func(t *testing.T) {
		got := parseCSV(" a@b.com , C@D.COM , e@f.com ")
		want := []string{"a@b.com", "c@d.com", "e@f.com"}
		if len(got) != len(want) {
			t.Fatalf("got %v, want %v", got, want)
		}
		for i, v := range want {
			if got[i] != v {
				t.Fatalf("got[%d] = %q, want %q", i, got[i], v)
			}
		}
	})

	t.Run("empty segments filtered", func(t *testing.T) {
		got := parseCSV("a,,b, ,c")
		want := []string{"a", "b", "c"}
		if len(got) != len(want) {
			t.Fatalf("got %v, want %v", got, want)
		}
	})
}

func TestValidateTunnelAuth(t *testing.T) {
	t.Run("all empty is valid", func(t *testing.T) {
		c := Config{}
		if err := c.ValidateTunnelAuth(); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	t.Run("half configured without client ID", func(t *testing.T) {
		c := Config{TunnelAuthSecret: "secret"}
		if err := c.ValidateTunnelAuth(); err == nil {
			t.Fatal("expected error for partial config")
		}
	})

	t.Run("half configured with allowed emails only", func(t *testing.T) {
		c := Config{TunnelAuthAllowedEmails: []string{"a@b.com"}}
		if err := c.ValidateTunnelAuth(); err == nil {
			t.Fatal("expected error for partial config")
		}
	})

	t.Run("missing client secret", func(t *testing.T) {
		c := Config{
			GoogleOAuthClientID: "id",
			TunnelAuthSecret:    "secret",
			TunnelAuthAllowedEmails: []string{"a@b.com"},
		}
		if err := c.ValidateTunnelAuth(); err == nil {
			t.Fatal("expected error for missing client secret")
		}
	})

	t.Run("missing auth secret", func(t *testing.T) {
		c := Config{
			GoogleOAuthClientID:     "id",
			GoogleOAuthClientSecret: "secret",
			TunnelAuthAllowedEmails: []string{"a@b.com"},
		}
		if err := c.ValidateTunnelAuth(); err == nil {
			t.Fatal("expected error for missing tunnel auth secret")
		}
	})

	t.Run("missing allowed identities", func(t *testing.T) {
		c := Config{
			GoogleOAuthClientID:     "id",
			GoogleOAuthClientSecret: "secret",
			TunnelAuthSecret:        "auth-secret",
		}
		if err := c.ValidateTunnelAuth(); err == nil {
			t.Fatal("expected error for missing allowed emails/domains")
		}
	})

	t.Run("valid with emails", func(t *testing.T) {
		c := Config{
			GoogleOAuthClientID:     "id",
			GoogleOAuthClientSecret: "secret",
			TunnelAuthSecret:        "auth-secret",
			TunnelAuthAllowedEmails: []string{"a@b.com"},
		}
		if err := c.ValidateTunnelAuth(); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	t.Run("valid with domains", func(t *testing.T) {
		c := Config{
			GoogleOAuthClientID:     "id",
			GoogleOAuthClientSecret: "secret",
			TunnelAuthSecret:        "auth-secret",
			TunnelAuthAllowedDomains: []string{"example.com"},
		}
		if err := c.ValidateTunnelAuth(); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	})
}

func TestFromEnvTunnelAuthFields(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DATA_DIR", dir)
	t.Setenv("GOOGLE_OAUTH_CLIENT_ID", "test-client-id")
	t.Setenv("GOOGLE_OAUTH_CLIENT_SECRET", "test-secret")
	t.Setenv("TUNNEL_AUTH_SECRET", "hmac-secret")
	t.Setenv("TUNNEL_AUTH_ALLOWED_EMAILS", "alice@example.com, BOB@Example.COM")
	t.Setenv("TUNNEL_AUTH_ALLOWED_DOMAINS", "example.com")
	t.Setenv("TRUST_PROXY_HEADERS", "true")
	t.Setenv("ENABLE_BATCH_SESSION_CREATE", "1")
	t.Setenv("RATE_LIMIT_TUNNEL_AUTH_STARTS_PER_HOUR", "5")
	t.Setenv("RATE_LIMIT_TUNNEL_AUTH_CALLBACKS_PER_HOUR", "15")

	cfg := FromEnv()

	if cfg.GoogleOAuthClientID != "test-client-id" {
		t.Fatalf("GoogleOAuthClientID = %q", cfg.GoogleOAuthClientID)
	}
	if cfg.GoogleOAuthClientSecret != "test-secret" {
		t.Fatalf("GoogleOAuthClientSecret = %q", cfg.GoogleOAuthClientSecret)
	}
	if cfg.TunnelAuthSecret != "hmac-secret" {
		t.Fatalf("TunnelAuthSecret = %q", cfg.TunnelAuthSecret)
	}
	if len(cfg.TunnelAuthAllowedEmails) != 2 || cfg.TunnelAuthAllowedEmails[0] != "alice@example.com" || cfg.TunnelAuthAllowedEmails[1] != "bob@example.com" {
		t.Fatalf("TunnelAuthAllowedEmails = %v", cfg.TunnelAuthAllowedEmails)
	}
	if len(cfg.TunnelAuthAllowedDomains) != 1 || cfg.TunnelAuthAllowedDomains[0] != "example.com" {
		t.Fatalf("TunnelAuthAllowedDomains = %v", cfg.TunnelAuthAllowedDomains)
	}
	if !cfg.TrustProxyHeaders {
		t.Fatal("TrustProxyHeaders should be true")
	}
	if !cfg.EnableBatchSessionCreate {
		t.Fatal("EnableBatchSessionCreate should be true")
	}
	if cfg.RateLimitTunnelAuthStartsPerHour != 5 {
		t.Fatalf("RateLimitTunnelAuthStartsPerHour = %d", cfg.RateLimitTunnelAuthStartsPerHour)
	}
	if cfg.RateLimitTunnelAuthCallbacksPerHour != 15 {
		t.Fatalf("RateLimitTunnelAuthCallbacksPerHour = %d", cfg.RateLimitTunnelAuthCallbacksPerHour)
	}
}

func TestValidateTunnelBaseURL(t *testing.T) {
	if err := (Config{}).ValidateTunnelBaseURL(); err != nil {
		t.Fatalf("empty TunnelBaseURL should pass: %v", err)
	}
	if err := (Config{TunnelBaseURL: "https://tunnel.example.com/"}).ValidateTunnelBaseURL(); err != nil {
		t.Fatalf("https URL should pass: %v", err)
	}
	if err := (Config{TunnelBaseURL: "http://localhost:3001/"}).ValidateTunnelBaseURL(); err != nil {
		t.Fatalf("http URL should pass: %v", err)
	}
	if err := (Config{TunnelBaseURL: "ftp://bad.example.com/"}).ValidateTunnelBaseURL(); err == nil {
		t.Fatal("ftp URL should fail validation")
	}
	if err := (Config{TunnelBaseURL: "tunnel.example.com"}).ValidateTunnelBaseURL(); err == nil {
		t.Fatal("URL without scheme should fail validation")
	}
}

func TestTunnelAuthEnabled(t *testing.T) {
	if (Config{}).TunnelAuthEnabled() {
		t.Fatal("empty config should not enable tunnel auth")
	}
	if !(Config{GoogleOAuthClientID: "id"}).TunnelAuthEnabled() {
		t.Fatal("config with client ID should enable tunnel auth")
	}
}

func TestFromEnvDefaults(t *testing.T) {
	// Clear all env vars that FromEnv reads to test default values.
	for _, key := range []string{
		"DATA_DIR", "PORT", "SESSION_EXPIRY_HOURS", "MAX_CLIP_BYTES",
		"MAX_SESSION_BYTES", "MAX_CLIPS_PER_ZONE", "RATE_LIMIT_CREATE_PER_HOUR",
		"RATE_LIMIT_BATCH_CREATE_PER_HOUR", "RATE_LIMIT_LOOKUPS_PER_MINUTE",
		"RATE_LIMIT_SIGNALS_PER_MINUTE", "RATE_LIMIT_UPLOADS_PER_MINUTE",
		"CLEANUP_INTERVAL_MS", "TURN_SECRET", "TURN_SERVER", "DOWNLOADS_DIR",
		"ENABLE_BATCH_SESSION_CREATE", "TRUST_PROXY_HEADERS",
		"GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET",
		"TUNNEL_AUTH_SECRET", "TUNNEL_AUTH_ALLOWED_EMAILS",
		"TUNNEL_AUTH_ALLOWED_DOMAINS", "RATE_LIMIT_TUNNEL_AUTH_STARTS_PER_HOUR",
		"RATE_LIMIT_TUNNEL_AUTH_CALLBACKS_PER_HOUR", "TUNNEL_BASE_URL",
	} {
		t.Setenv(key, "")
	}

	cfg := FromEnv()

	if cfg.Port != 3000 {
		t.Errorf("Port = %d, want 3000", cfg.Port)
	}
	if cfg.SessionExpiryHours != 24 {
		t.Errorf("SessionExpiryHours = %d, want 24", cfg.SessionExpiryHours)
	}
	if cfg.MaxClipBytes != 512*1024 {
		t.Errorf("MaxClipBytes = %d, want %d", cfg.MaxClipBytes, 512*1024)
	}
	if cfg.MaxSessionBytes != 100*1024*1024 {
		t.Errorf("MaxSessionBytes = %d, want %d", cfg.MaxSessionBytes, 100*1024*1024)
	}
	if cfg.MaxClipsPerZone != 100 {
		t.Errorf("MaxClipsPerZone = %d, want 100", cfg.MaxClipsPerZone)
	}
	if cfg.RateLimitCreatePerHour != 20 {
		t.Errorf("RateLimitCreatePerHour = %d, want 20", cfg.RateLimitCreatePerHour)
	}
	if cfg.RateLimitSignalsPerMinute != 240 {
		t.Errorf("RateLimitSignalsPerMinute = %d, want 240", cfg.RateLimitSignalsPerMinute)
	}
	if cfg.CleanupInterval != time.Duration(60*60*1000)*time.Millisecond {
		t.Errorf("CleanupInterval = %s, want 1h", cfg.CleanupInterval)
	}
	if cfg.TurnSecret != "" {
		t.Errorf("TurnSecret = %q, want empty", cfg.TurnSecret)
	}
	if cfg.TurnServer != "" {
		t.Errorf("TurnServer = %q, want empty", cfg.TurnServer)
	}
	if cfg.EnableBatchSessionCreate {
		t.Error("EnableBatchSessionCreate should default to false")
	}
	if cfg.TrustProxyHeaders {
		t.Error("TrustProxyHeaders should default to false")
	}
	if cfg.GoogleOAuthClientID != "" {
		t.Errorf("GoogleOAuthClientID = %q, want empty", cfg.GoogleOAuthClientID)
	}
	if cfg.TunnelBaseURL != "" {
		t.Errorf("TunnelBaseURL = %q, want empty", cfg.TunnelBaseURL)
	}
	if cfg.RateLimitTunnelAuthStartsPerHour != 10 {
		t.Errorf("RateLimitTunnelAuthStartsPerHour = %d, want 10", cfg.RateLimitTunnelAuthStartsPerHour)
	}
	if cfg.RateLimitTunnelAuthCallbacksPerHour != 30 {
		t.Errorf("RateLimitTunnelAuthCallbacksPerHour = %d, want 30", cfg.RateLimitTunnelAuthCallbacksPerHour)
	}
}

func TestFromEnvTurnFields(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DATA_DIR", dir)
	t.Setenv("TURN_SECRET", "my-turn-secret")
	t.Setenv("TURN_SERVER", "turn.example.com")
	t.Setenv("TUNNEL_BASE_URL", "https://tunnel.example.com/")
	t.Setenv("RATE_LIMIT_SIGNALS_PER_MINUTE", "500")

	cfg := FromEnv()

	if cfg.TurnSecret != "my-turn-secret" {
		t.Fatalf("TurnSecret = %q", cfg.TurnSecret)
	}
	if cfg.TurnServer != "turn.example.com" {
		t.Fatalf("TurnServer = %q", cfg.TurnServer)
	}
	if cfg.TunnelBaseURL != "https://tunnel.example.com/" {
		t.Fatalf("TunnelBaseURL = %q", cfg.TunnelBaseURL)
	}
	if cfg.RateLimitSignalsPerMinute != 500 {
		t.Fatalf("RateLimitSignalsPerMinute = %d", cfg.RateLimitSignalsPerMinute)
	}
}

func TestValidateTunnelAuth_PartialWithSecret(t *testing.T) {
	// GoogleOAuthClientSecret set without client ID
	c := Config{GoogleOAuthClientSecret: "secret"}
	if err := c.ValidateTunnelAuth(); err == nil {
		t.Fatal("expected error for partial config with only client secret")
	}
}

func TestValidateTunnelAuth_PartialWithDomains(t *testing.T) {
	c := Config{TunnelAuthAllowedDomains: []string{"example.com"}}
	if err := c.ValidateTunnelAuth(); err == nil {
		t.Fatal("expected error for partial config with only allowed domains")
	}
}

func TestValidateTunnelBaseURL_EdgeCases(t *testing.T) {
	// ws:// scheme should fail
	if err := (Config{TunnelBaseURL: "ws://example.com/"}).ValidateTunnelBaseURL(); err == nil {
		t.Fatal("ws URL should fail validation")
	}
	// Just a bare path should fail
	if err := (Config{TunnelBaseURL: "/tunnel/"}).ValidateTunnelBaseURL(); err == nil {
		t.Fatal("bare path should fail validation")
	}
}

func TestParseCSV_OnlyCommas(t *testing.T) {
	got := parseCSV(",,,")
	if len(got) != 0 {
		t.Fatalf("expected empty slice for only commas, got %v", got)
	}
}

func TestGetenvBool_ViaFromEnv(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DATA_DIR", dir)
	t.Setenv("ENABLE_BATCH_SESSION_CREATE", "false")
	t.Setenv("TRUST_PROXY_HEADERS", "0")

	cfg := FromEnv()
	if cfg.EnableBatchSessionCreate {
		t.Error("EnableBatchSessionCreate should be false")
	}
	if cfg.TrustProxyHeaders {
		t.Error("TrustProxyHeaders should be false")
	}
}

func TestFromEnvTunnelBaseURL(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DATA_DIR", dir)
	t.Setenv("TUNNEL_BASE_URL", "https://tunnel.test.com/")
	cfg := FromEnv()
	if cfg.TunnelBaseURL != "https://tunnel.test.com/" {
		t.Fatalf("TunnelBaseURL = %q", cfg.TunnelBaseURL)
	}
}

func TestFromEnvAllowedDomainsOnly(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DATA_DIR", dir)
	t.Setenv("TUNNEL_AUTH_ALLOWED_EMAILS", "")
	t.Setenv("TUNNEL_AUTH_ALLOWED_DOMAINS", "example.com, test.org")
	cfg := FromEnv()
	if len(cfg.TunnelAuthAllowedDomains) != 2 {
		t.Fatalf("TunnelAuthAllowedDomains = %v", cfg.TunnelAuthAllowedDomains)
	}
	if len(cfg.TunnelAuthAllowedEmails) != 0 {
		t.Fatalf("TunnelAuthAllowedEmails should be nil, got %v", cfg.TunnelAuthAllowedEmails)
	}
}

func TestFromEnvBatchCreateEnabled(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DATA_DIR", dir)
	t.Setenv("ENABLE_BATCH_SESSION_CREATE", "yes")
	cfg := FromEnv()
	if !cfg.EnableBatchSessionCreate {
		t.Fatal("EnableBatchSessionCreate should be true with 'yes'")
	}
}

func TestFromEnvTrustProxyOn(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DATA_DIR", dir)
	t.Setenv("TRUST_PROXY_HEADERS", "on")
	cfg := FromEnv()
	if !cfg.TrustProxyHeaders {
		t.Fatal("TrustProxyHeaders should be true with 'on'")
	}
}

func TestFromEnvGetenvIntInvalidReturnsDefault(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DATA_DIR", dir)
	t.Setenv("PORT", "not-a-number")
	cfg := FromEnv()
	if cfg.Port != 3000 {
		t.Errorf("Port with invalid PORT env = %d, want 3000", cfg.Port)
	}
}

func TestPlausibleEnvVars(t *testing.T) {
	t.Setenv("PLAUSIBLE_SCRIPT_URL", "https://stats.example.com/js/pa-TEST.js")
	t.Setenv("PLAUSIBLE_EVENT_URL", "https://stats.example.com/api/event")
	cfg := FromEnv()
	if got, want := cfg.PlausibleScriptURL, "https://stats.example.com/js/pa-TEST.js"; got != want {
		t.Fatalf("PlausibleScriptURL = %q, want %q", got, want)
	}
	if got, want := cfg.PlausibleEventURL, "https://stats.example.com/api/event"; got != want {
		t.Fatalf("PlausibleEventURL = %q, want %q", got, want)
	}
}

func TestPlausibleEnvVarsDefaults(t *testing.T) {
	t.Setenv("PLAUSIBLE_SCRIPT_URL", "")
	t.Setenv("PLAUSIBLE_EVENT_URL", "")
	cfg := FromEnv()
	if cfg.PlausibleScriptURL != "" {
		t.Fatalf("PlausibleScriptURL should default to empty, got %q", cfg.PlausibleScriptURL)
	}
	if cfg.PlausibleEventURL != "" {
		t.Fatalf("PlausibleEventURL default = %q, want empty", cfg.PlausibleEventURL)
	}
}

func TestFromEnvAllFieldsExplicit(t *testing.T) {
	// Set every single field explicitly to exercise all getenv/getenvInt/getenvBool calls.
	dir := t.TempDir()
	t.Setenv("DATA_DIR", dir)
	t.Setenv("PORT", "9999")
	t.Setenv("DOWNLOADS_DIR", "/tmp/dl")
	t.Setenv("SESSION_EXPIRY_HOURS", "48")
	t.Setenv("MAX_CLIP_BYTES", "1024")
	t.Setenv("MAX_SESSION_BYTES", "2048")
	t.Setenv("MAX_CLIPS_PER_ZONE", "50")
	t.Setenv("RATE_LIMIT_CREATE_PER_HOUR", "10")
	t.Setenv("RATE_LIMIT_BATCH_CREATE_PER_HOUR", "30")
	t.Setenv("RATE_LIMIT_LOOKUPS_PER_MINUTE", "5")
	t.Setenv("RATE_LIMIT_SIGNALS_PER_MINUTE", "120")
	t.Setenv("RATE_LIMIT_UPLOADS_PER_MINUTE", "15")
	t.Setenv("CLEANUP_INTERVAL_MS", "5000")
	t.Setenv("TURN_SECRET", "test-secret")
	t.Setenv("TURN_SERVER", "turn.test.com")
	t.Setenv("ENABLE_BATCH_SESSION_CREATE", "TRUE")
	t.Setenv("TRUST_PROXY_HEADERS", "TRUE")
	t.Setenv("GOOGLE_OAUTH_CLIENT_ID", "cid")
	t.Setenv("GOOGLE_OAUTH_CLIENT_SECRET", "csec")
	t.Setenv("TUNNEL_AUTH_SECRET", "tsec")
	t.Setenv("TUNNEL_AUTH_ALLOWED_EMAILS", "a@b.com")
	t.Setenv("TUNNEL_AUTH_ALLOWED_DOMAINS", "b.com")
	t.Setenv("RATE_LIMIT_TUNNEL_AUTH_STARTS_PER_HOUR", "20")
	t.Setenv("RATE_LIMIT_TUNNEL_AUTH_CALLBACKS_PER_HOUR", "60")
	t.Setenv("TUNNEL_BASE_URL", "https://t.example.com/")
	t.Setenv("STATS_DASHBOARD_KEY", "dash-key-123")
	t.Setenv("PLAUSIBLE_SCRIPT_URL", "https://pa.example.com/js/pa.js")
	t.Setenv("PLAUSIBLE_EVENT_URL", "https://pa.example.com/api/event")

	cfg := FromEnv()

	if cfg.Port != 9999 {
		t.Errorf("Port = %d", cfg.Port)
	}
	if cfg.DownloadsDir != "/tmp/dl" {
		t.Errorf("DownloadsDir = %q", cfg.DownloadsDir)
	}
	if cfg.SessionExpiryHours != 48 {
		t.Errorf("SessionExpiryHours = %d", cfg.SessionExpiryHours)
	}
	if cfg.MaxClipBytes != 1024 {
		t.Errorf("MaxClipBytes = %d", cfg.MaxClipBytes)
	}
	if cfg.MaxSessionBytes != 2048 {
		t.Errorf("MaxSessionBytes = %d", cfg.MaxSessionBytes)
	}
	if cfg.MaxClipsPerZone != 50 {
		t.Errorf("MaxClipsPerZone = %d", cfg.MaxClipsPerZone)
	}
	if cfg.RateLimitCreatePerHour != 10 {
		t.Errorf("RateLimitCreatePerHour = %d", cfg.RateLimitCreatePerHour)
	}
	if cfg.RateLimitBatchCreatePerHour != 30 {
		t.Errorf("RateLimitBatchCreatePerHour = %d", cfg.RateLimitBatchCreatePerHour)
	}
	if cfg.RateLimitLookupsPerMinute != 5 {
		t.Errorf("RateLimitLookupsPerMinute = %d", cfg.RateLimitLookupsPerMinute)
	}
	if cfg.RateLimitSignalsPerMinute != 120 {
		t.Errorf("RateLimitSignalsPerMinute = %d", cfg.RateLimitSignalsPerMinute)
	}
	if cfg.RateLimitUploadsPerMinute != 15 {
		t.Errorf("RateLimitUploadsPerMinute = %d", cfg.RateLimitUploadsPerMinute)
	}
	if cfg.CleanupInterval != 5000*time.Millisecond {
		t.Errorf("CleanupInterval = %v", cfg.CleanupInterval)
	}
	if cfg.TurnSecret != "test-secret" {
		t.Errorf("TurnSecret = %q", cfg.TurnSecret)
	}
	if cfg.TurnServer != "turn.test.com" {
		t.Errorf("TurnServer = %q", cfg.TurnServer)
	}
	if !cfg.EnableBatchSessionCreate {
		t.Error("EnableBatchSessionCreate should be true")
	}
	if !cfg.TrustProxyHeaders {
		t.Error("TrustProxyHeaders should be true")
	}
	if cfg.GoogleOAuthClientID != "cid" {
		t.Errorf("GoogleOAuthClientID = %q", cfg.GoogleOAuthClientID)
	}
	if cfg.GoogleOAuthClientSecret != "csec" {
		t.Errorf("GoogleOAuthClientSecret = %q", cfg.GoogleOAuthClientSecret)
	}
	if cfg.TunnelAuthSecret != "tsec" {
		t.Errorf("TunnelAuthSecret = %q", cfg.TunnelAuthSecret)
	}
	if cfg.RateLimitTunnelAuthStartsPerHour != 20 {
		t.Errorf("RateLimitTunnelAuthStartsPerHour = %d", cfg.RateLimitTunnelAuthStartsPerHour)
	}
	if cfg.RateLimitTunnelAuthCallbacksPerHour != 60 {
		t.Errorf("RateLimitTunnelAuthCallbacksPerHour = %d", cfg.RateLimitTunnelAuthCallbacksPerHour)
	}
	if cfg.TunnelBaseURL != "https://t.example.com/" {
		t.Errorf("TunnelBaseURL = %q", cfg.TunnelBaseURL)
	}
	if cfg.StatsDashboardKey != "dash-key-123" {
		t.Errorf("StatsDashboardKey = %q", cfg.StatsDashboardKey)
	}
	if cfg.PlausibleScriptURL != "https://pa.example.com/js/pa.js" {
		t.Errorf("PlausibleScriptURL = %q", cfg.PlausibleScriptURL)
	}
	if cfg.PlausibleEventURL != "https://pa.example.com/api/event" {
		t.Errorf("PlausibleEventURL = %q", cfg.PlausibleEventURL)
	}
}

func TestFromEnv_GetwdErrorFallback(t *testing.T) {
	// When os.Getwd() fails, FromEnv should fall back to "." for path construction.
	// We trigger this by chdir-ing into a temp directory and then removing it.
	// On Linux, os.Getwd() returns an error when cwd no longer exists.

	// Clear DATA_DIR and DOWNLOADS_DIR so FromEnv uses the wd-based defaults.
	t.Setenv("DATA_DIR", "")
	t.Setenv("DOWNLOADS_DIR", "")

	// Save original working directory to restore after the test.
	origWd, err := os.Getwd()
	if err != nil {
		t.Fatalf("failed to get original wd: %v", err)
	}

	// Create a temp dir, chdir into it, then remove it to break os.Getwd().
	tmp, err := os.MkdirTemp("", "config-getwd-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	if err := os.Chdir(tmp); err != nil {
		os.RemoveAll(tmp)
		t.Fatalf("failed to chdir: %v", err)
	}
	// Remove the directory out from under us.
	os.RemoveAll(tmp)

	// Ensure we restore cwd regardless of test outcome.
	defer func() {
		os.Chdir(origWd)
	}()

	cfg := FromEnv()

	// With getwd failing, wd falls back to ".", so defaults become:
	//   DataDir      = filepath.Join(".", "data")      = "data"
	//   DownloadsDir = filepath.Join(".", "downloads")  = "downloads"
	wantData := filepath.Join(".", "data")
	wantDownloads := filepath.Join(".", "downloads")
	if cfg.DataDir != wantData {
		t.Errorf("DataDir = %q, want %q (getwd error fallback)", cfg.DataDir, wantData)
	}
	if cfg.DownloadsDir != wantDownloads {
		t.Errorf("DownloadsDir = %q, want %q (getwd error fallback)", cfg.DownloadsDir, wantDownloads)
	}
	// Verify the paths don't contain the deleted temp directory.
	if strings.Contains(cfg.DataDir, tmp) {
		t.Errorf("DataDir %q unexpectedly contains deleted dir %q", cfg.DataDir, tmp)
	}
}

func TestValidateSessionExpiry(t *testing.T) {
	cases := []struct {
		name    string
		hours   int
		wantErr bool
	}{
		{"default 24h", 24, false},
		{"minimum 1h", 1, false},
		{"maximum one year", 8760, false},
		{"zero rejected", 0, true},
		{"negative rejected", -1, true},
		{"over a year rejected", 8761, true},
		{"overflow value rejected", 9223372036854, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := Config{SessionExpiryHours: tc.hours}
			err := c.ValidateSessionExpiry()
			if tc.wantErr && err == nil {
				t.Fatalf("expected error for %d hours", tc.hours)
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error for %d hours: %v", tc.hours, err)
			}
		})
	}
}

func TestValidateSecretStrength(t *testing.T) {
	t.Run("empty secrets are allowed (feature disabled)", func(t *testing.T) {
		if err := (Config{}).ValidateSecretStrength(); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	})
	t.Run("short tunnel auth secret rejected", func(t *testing.T) {
		if err := (Config{TunnelAuthSecret: "too-short"}).ValidateSecretStrength(); err == nil {
			t.Fatal("expected error for short TUNNEL_AUTH_SECRET")
		}
	})
	t.Run("strong tunnel auth secret accepted", func(t *testing.T) {
		c := Config{TunnelAuthSecret: "this-secret-is-definitely-at-least-32-bytes"}
		if err := c.ValidateSecretStrength(); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	})
	t.Run("short stats dashboard key rejected", func(t *testing.T) {
		if err := (Config{StatsDashboardKey: "short"}).ValidateSecretStrength(); err == nil {
			t.Fatal("expected error for short STATS_DASHBOARD_KEY")
		}
	})
	t.Run("strong stats dashboard key accepted", func(t *testing.T) {
		if err := (Config{StatsDashboardKey: "a-sufficiently-long-key"}).ValidateSecretStrength(); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	})
}

func TestValidateAggregatesChecks(t *testing.T) {
	t.Run("valid config passes", func(t *testing.T) {
		c := Config{SessionExpiryHours: 24}
		if err := c.Validate(); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	})
	t.Run("invalid expiry fails the aggregate", func(t *testing.T) {
		c := Config{SessionExpiryHours: 0}
		if err := c.Validate(); err == nil {
			t.Fatal("expected aggregate validation to fail on expiry")
		}
	})
}
