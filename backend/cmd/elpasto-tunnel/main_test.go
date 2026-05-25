package main

import (
	"bytes"
	"io"
	"log"
	"strings"
	"testing"
)

func restoreMainHooks() func() {
	origExit := osExit
	origRunMain := runMain
	origExecute := executeMain
	return func() {
		osExit = origExit
		runMain = origRunMain
		executeMain = origExecute
	}
}

func TestMainCallsRunAndExit(t *testing.T) {
	restore := restoreMainHooks()
	defer restore()

	runMain = func([]string, io.Writer) int { return 7 }
	osExit = func(code int) { panic(code) }

	defer func() {
		recovered := recover()
		if recovered != 7 {
			t.Fatalf("expected exit code 7 panic, got %v", recovered)
		}
	}()

	main()
}

func TestParseCLIArgsValidationFailures(t *testing.T) {
	tests := []struct {
		name        string
		args        []string
		wantCode    int
		wantMessage string
	}{
		{
			name:        "parse error",
			args:        []string{"--port", "nope"},
			wantCode:    2,
			wantMessage: "invalid value",
		},
		{
			name:        "missing session",
			args:        []string{"--port", "8080"},
			wantCode:    1,
			wantMessage: "--session is required",
		},
		{
			name:        "missing mode",
			args:        []string{"--session", "s", "--port", "8080", "--mode", "invalid"},
			wantCode:    1,
			wantMessage: "--mode must be auto, relay, or webrtc",
		},
		{
			name:        "missing target",
			args:        []string{"--session", "s"},
			wantCode:    1,
			wantMessage: "exactly one of --port or --dir is required",
		},
		{
			name:        "both targets",
			args:        []string{"--session", "s", "--port", "8080", "--dir", t.TempDir()},
			wantCode:    1,
			wantMessage: "exactly one of --port or --dir is required",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var stderr bytes.Buffer
			_, code := parseCLIArgs(tt.args, &stderr)
			if code != tt.wantCode {
				t.Fatalf("parseCLIArgs code = %d, want %d", code, tt.wantCode)
			}
			if !strings.Contains(stderr.String(), tt.wantMessage) {
				t.Fatalf("stderr = %q, want substring %q", stderr.String(), tt.wantMessage)
			}
		})
	}
}

func TestParseCLIArgsSuccess(t *testing.T) {
	dir := t.TempDir()

	cfg, code := parseCLIArgs([]string{
		"--session", "amber-anchor-apple-arch-arrow",
		"--dir", dir,
		"--label", "docs",
		"--server", "http://127.0.0.1:8080",
		"--mode", "relay",
	}, io.Discard)
	if code != 0 {
		t.Fatalf("parseCLIArgs code = %d, want 0", code)
	}
	if cfg.session != "amber-anchor-apple-arch-arrow" {
		t.Fatalf("session = %q", cfg.session)
	}
	if cfg.dir != dir || cfg.label != "docs" {
		t.Fatalf("unexpected cfg: %+v", cfg)
	}
	if cfg.serverURL != "http://127.0.0.1:8080" || cfg.mode != "relay" {
		t.Fatalf("unexpected cfg: %+v", cfg)
	}
}

func TestRunPassesParsedConfigToExecutor(t *testing.T) {
	restore := restoreMainHooks()
	defer restore()

	var captured tunnelCLIConfig
	executeMain = func(cfg tunnelCLIConfig, logger *log.Logger) {
		captured = cfg
		logger.Print("executed")
	}

	var stderr bytes.Buffer
	code := run([]string{"--session", "s", "--port", "9000"}, &stderr)
	if code != 0 {
		t.Fatalf("run code = %d, want 0", code)
	}
	if captured.session != "s" || captured.port != 9000 {
		t.Fatalf("unexpected captured cfg: %+v", captured)
	}
	if captured.serverURL != "http://127.0.0.1:8080" || captured.mode != "auto" {
		t.Fatalf("unexpected default cfg: %+v", captured)
	}
	if !strings.Contains(stderr.String(), "executed") {
		t.Fatalf("stderr = %q, want executor log", stderr.String())
	}
}
