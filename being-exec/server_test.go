package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"log/slog"
	"os"
)

func testServer(t *testing.T, allow []AllowEntry) *server {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
	cfg := defaultConfig()
	cfg.Tokens = []string{"test-token"}
	cfg.Allow = allow
	srv, err := newServer(cfg, logger)
	if err != nil {
		t.Fatalf("newServer: %v", err)
	}
	return srv
}

func doExec(t *testing.T, srv *server, token, command string) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(execRequest{Command: command})
	req := httptest.NewRequest(http.MethodPost, "/exec", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rr := httptest.NewRecorder()
	srv.ServeHTTP(rr, req)
	return rr
}

func doExecWithTimeout(t *testing.T, srv *server, token, command string, timeoutMs int) *httptest.ResponseRecorder {
	t.Helper()
	reqBody := struct {
		Command   string `json:"command"`
		TimeoutMs *int   `json:"timeout_ms"`
	}{Command: command, TimeoutMs: &timeoutMs}
	body, _ := json.Marshal(reqBody)
	req := httptest.NewRequest(http.MethodPost, "/exec", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rr := httptest.NewRecorder()
	srv.ServeHTTP(rr, req)
	return rr
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

func TestExec_NoToken_Returns401(t *testing.T) {
	srv := testServer(t, nil)
	rr := doExec(t, srv, "", "echo hello")
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("want 401, got %d", rr.Code)
	}
}

func TestExec_WrongToken_Returns401(t *testing.T) {
	srv := testServer(t, nil)
	rr := doExec(t, srv, "wrong-token", "echo hello")
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("want 401, got %d", rr.Code)
	}
}

// ─── Allowlist ────────────────────────────────────────────────────────────────

func TestExec_NoAllowList_Returns403(t *testing.T) {
	srv := testServer(t, nil)
	rr := doExec(t, srv, "test-token", "echo hello")
	if rr.Code != http.StatusForbidden {
		t.Errorf("want 403, got %d", rr.Code)
	}
}

func TestExec_OffAllowList_Returns403(t *testing.T) {
	allow := []AllowEntry{{Pattern: "uptime"}}
	srv := testServer(t, allow)
	rr := doExec(t, srv, "test-token", "rm -rf /")
	if rr.Code != http.StatusForbidden {
		t.Errorf("want 403, got %d", rr.Code)
	}
}

// ─── Successful execution ────────────────────────────────────────────────────

func TestExec_Allowed_ReturnsOutput(t *testing.T) {
	allow := []AllowEntry{{Pattern: "echo hello"}}
	srv := testServer(t, allow)
	rr := doExec(t, srv, "test-token", "echo hello")
	if rr.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", rr.Code, rr.Body.String())
	}
	var resp execResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	want := "hello\n"
	if resp.Stdout != want {
		t.Errorf("stdout: want %q, got %q", want, resp.Stdout)
	}
	if resp.ExitCode != 0 {
		t.Errorf("exit_code: want 0, got %d", resp.ExitCode)
	}
}

func TestExec_NonZeroExit(t *testing.T) {
	allow := []AllowEntry{{Pattern: "false"}}
	srv := testServer(t, allow)
	rr := doExec(t, srv, "test-token", "false")
	if rr.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rr.Code)
	}
	var resp execResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.ExitCode == 0 {
		t.Errorf("expected non-zero exit code")
	}
}

// ─── /health ─────────────────────────────────────────────────────────────────

func TestHealth(t *testing.T) {
	srv := testServer(t, nil)
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rr := httptest.NewRecorder()
	srv.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("want 200, got %d", rr.Code)
	}
	var resp healthResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Status != "ok" {
		t.Errorf("want status ok, got %q", resp.Status)
	}
	if resp.Version == "" {
		t.Errorf("want non-empty version")
	}
}

// ─── Request validation ───────────────────────────────────────────────────────

func TestExec_EmptyCommand_Returns400(t *testing.T) {
	allow := []AllowEntry{{Pattern: ".*"}}
	srv := testServer(t, allow)
	rr := doExec(t, srv, "test-token", "")
	if rr.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", rr.Code)
	}
}

// ─── Anchoring ────────────────────────────────────────────────────────────────

// Pattern "uptime" should NOT match "uptime --badarg; rm -rf /"
func TestExec_PatternAnchoring_BlocksPartialMatch(t *testing.T) {
	allow := []AllowEntry{{Pattern: "uptime"}}
	srv := testServer(t, allow)
	rr := doExec(t, srv, "test-token", "uptime --badarg; rm -rf /")
	if rr.Code != http.StatusForbidden {
		t.Errorf("want 403, got %d (anchoring failed)", rr.Code)
	}
}

// ─── Timeout ──────────────────────────────────────────────────────────────────

func TestExec_Timeout_Returns408(t *testing.T) {
	allow := []AllowEntry{{Pattern: "sleep \\d+", ShellExpand: true}}
	srv := testServer(t, allow)
	rr := doExecWithTimeout(t, srv, "test-token", "sleep 10", 100)
	if rr.Code != http.StatusRequestTimeout {
		t.Errorf("want 408, got %d: %s", rr.Code, rr.Body.String())
	}
}

// ─── Invalid regex pattern ────────────────────────────────────────────────────

func TestCompileAllowlist_InvalidPattern_ReturnsError(t *testing.T) {
	entries := []AllowEntry{{Pattern: "[invalid"}}
	_, err := compileAllowlist(entries)
	if err == nil {
		t.Errorf("expected error for invalid regex pattern")
	}
}

// ─── UTF-8 safe truncation ────────────────────────────────────────────────────

func TestTruncateUTF8_MultibyteChar(t *testing.T) {
	// "あいう" = 9 bytes (3 bytes per char). Truncating at 7 should give "あい" (6 bytes).
	s := "あいう"
	result := truncateUTF8(s, 7)
	if result != "あい" {
		t.Errorf("want %q, got %q", "あい", result)
	}
}
