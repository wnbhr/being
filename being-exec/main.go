package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

const version = "0.1.0"

// ─── Config ──────────────────────────────────────────────────────────────────

// AllowEntry defines one allowlist rule.
type AllowEntry struct {
	Pattern     string `yaml:"pattern"`
	ShellExpand bool   `yaml:"shell_expand"`
}

// Config holds the full server configuration.
type Config struct {
	Bind            string       `yaml:"bind"`
	Port            int          `yaml:"port"`
	Tokens          []string     `yaml:"tokens"`
	Allow           []AllowEntry `yaml:"allow"`
	MaxOutputBytes  int          `yaml:"max_output_bytes"`
	DefaultTimeout  int          `yaml:"default_timeout_ms"`
	MaxTimeout      int          `yaml:"max_timeout_ms"`
	MaxRequestBytes int64        `yaml:"max_request_bytes"`
}

func defaultConfig() Config {
	return Config{
		Bind:            "127.0.0.1",
		Port:            7070,
		MaxOutputBytes:  1 << 20,       // 1 MiB
		DefaultTimeout:  30000,         // 30s
		MaxTimeout:      300000,        // 5 min
		MaxRequestBytes: 10 << 20,      // 10 MiB
	}
}

// ─── Request / Response types ─────────────────────────────────────────────────

type execRequest struct {
	Command   string `json:"command"`
	TimeoutMs *int   `json:"timeout_ms"`
	Stdin     string `json:"stdin"`
}

type execResponse struct {
	ExitCode   int    `json:"exit_code"`
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	DurationMs int64  `json:"duration_ms"`
	Truncated  bool   `json:"truncated"`
}

type errorResponse struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}

type healthResponse struct {
	Status  string `json:"status"`
	Version string `json:"version"`
}

// ─── Compiled allowlist entry ─────────────────────────────────────────────────

type compiledAllow struct {
	re          *regexp.Regexp
	shellExpand bool
}

// ─── Server ───────────────────────────────────────────────────────────────────

type server struct {
	cfg      Config
	mux      *http.ServeMux
	logger   *slog.Logger
	patterns []compiledAllow
}

// compileAllowlist pre-compiles all regex patterns at startup.
// Returns an error if any pattern is invalid.
func compileAllowlist(entries []AllowEntry) ([]compiledAllow, error) {
	out := make([]compiledAllow, 0, len(entries))
	for _, entry := range entries {
		p := entry.Pattern
		if !strings.HasPrefix(p, "^") {
			p = "^" + p
		}
		if !strings.HasSuffix(p, "$") {
			p = p + "$"
		}
		re, err := regexp.Compile(p)
		if err != nil {
			return nil, fmt.Errorf("invalid allow pattern %q: %w", entry.Pattern, err)
		}
		out = append(out, compiledAllow{re: re, shellExpand: entry.ShellExpand})
	}
	return out, nil
}

func newServer(cfg Config, logger *slog.Logger) (*server, error) {
	patterns, err := compileAllowlist(cfg.Allow)
	if err != nil {
		return nil, err
	}
	s := &server{cfg: cfg, logger: logger, patterns: patterns}
	s.mux = http.NewServeMux()
	s.mux.HandleFunc("/exec", s.handleExec)
	s.mux.HandleFunc("/health", s.handleHealth)
	return s, nil
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

// validToken performs constant-time comparison against all configured tokens.
// Token values may reference environment variables (e.g. $BRIDGE_TOKEN).
func (s *server) validToken(provided string) bool {
	for _, tok := range s.cfg.Tokens {
		resolved := os.ExpandEnv(tok)
		if subtle.ConstantTimeCompare([]byte(provided), []byte(resolved)) == 1 {
			return true
		}
	}
	return false
}

func bearerToken(r *http.Request) (string, bool) {
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		return "", false
	}
	return strings.TrimPrefix(h, "Bearer "), true
}

// ─── Allowlist ────────────────────────────────────────────────────────────────

// allowedEntry returns the matching compiled entry for the given command, or nil.
func (s *server) allowedEntry(command string) *compiledAllow {
	for i, ca := range s.patterns {
		if ca.re.MatchString(command) {
			return &s.patterns[i]
		}
	}
	return nil
}

// ─── /exec ────────────────────────────────────────────────────────────────────

func (s *server) handleExec(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST required")
		return
	}

	// Auth
	tok, ok := bearerToken(r)
	if !ok || !s.validToken(tok) {
		writeError(w, http.StatusUnauthorized, "unauthorized", "missing or invalid bearer token")
		return
	}

	// Limit request body size
	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxRequestBytes)

	// Parse body
	var req execRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Command) == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "body must be valid JSON with non-empty command")
		return
	}

	// Allowlist check (before execution)
	entry := s.allowedEntry(req.Command)
	if entry == nil {
		s.logger.Info("exec forbidden", "command", req.Command, "remote", r.RemoteAddr)
		writeError(w, http.StatusForbidden, "forbidden", "command is not authorised")
		return
	}

	// Timeout — clamp to max
	timeoutMs := s.cfg.DefaultTimeout
	if req.TimeoutMs != nil {
		timeoutMs = *req.TimeoutMs
	}
	if s.cfg.MaxTimeout > 0 && timeoutMs > s.cfg.MaxTimeout {
		timeoutMs = s.cfg.MaxTimeout
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()

	// Build command — shell expansion only when explicitly opted in
	var cmd *exec.Cmd
	if entry.shellExpand {
		cmd = exec.CommandContext(ctx, "sh", "-c", req.Command)
	} else {
		parts := strings.Fields(req.Command)
		if len(parts) == 0 {
			writeError(w, http.StatusBadRequest, "invalid_request", "empty command")
			return
		}
		cmd = exec.CommandContext(ctx, parts[0], parts[1:]...)
	}

	// Restrict inherited environment
	cmd.Env = []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME=" + os.Getenv("HOME"),
	}
	// Forward XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS so that
	// `systemctl --user` and `journalctl --user` work when being-exec
	// runs as a regular user (e.g. ubuntu) under a system unit.
	for _, key := range []string{"XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"} {
		if v := os.Getenv(key); v != "" {
			cmd.Env = append(cmd.Env, key+"="+v)
		}
	}

	if req.Stdin != "" {
		cmd.Stdin = strings.NewReader(req.Stdin)
	}

	var stdoutBuf, stderrBuf strings.Builder
	cmd.Stdout = &stdoutBuf
	cmd.Stderr = &stderrBuf

	start := time.Now()
	runErr := cmd.Run()
	elapsed := time.Since(start).Milliseconds()

	// Timeout response
	if ctx.Err() == context.DeadlineExceeded {
		s.logger.Info("exec timeout", "command", req.Command, "timeout_ms", timeoutMs)
		stdout := stdoutBuf.String()
		stderr := stderrBuf.String()
		truncated := len(stdout) > s.cfg.MaxOutputBytes || len(stderr) > s.cfg.MaxOutputBytes
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusRequestTimeout)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"error":   "timeout",
			"message": "command exceeded timeout",
			"partial": execResponse{
				ExitCode:   -1,
				Stdout:     truncateUTF8(stdout, s.cfg.MaxOutputBytes),
				Stderr:     truncateUTF8(stderr, s.cfg.MaxOutputBytes),
				DurationMs: elapsed,
				Truncated:  truncated,
			},
		})
		return
	}

	exitCode := 0
	if runErr != nil {
		if exitErr, ok := runErr.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			s.logger.Error("exec spawn error", "command", req.Command, "error", runErr)
			writeError(w, http.StatusInternalServerError, "internal_error", "failed to execute command")
			return
		}
	}

	stdout := stdoutBuf.String()
	stderr := stderrBuf.String()
	truncated := len(stdout) > s.cfg.MaxOutputBytes || len(stderr) > s.cfg.MaxOutputBytes

	s.logger.Info("exec ok",
		"command", req.Command,
		"exit_code", exitCode,
		"duration_ms", elapsed,
		"truncated", truncated,
	)

	writeJSON(w, http.StatusOK, execResponse{
		ExitCode:   exitCode,
		Stdout:     truncateUTF8(stdout, s.cfg.MaxOutputBytes),
		Stderr:     truncateUTF8(stderr, s.cfg.MaxOutputBytes),
		DurationMs: elapsed,
		Truncated:  truncated,
	})
}

// ─── /health ─────────────────────────────────────────────────────────────────

func (s *server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, healthResponse{Status: "ok", Version: version})
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

func writeError(w http.ResponseWriter, code int, errKey, msg string) {
	writeJSON(w, code, errorResponse{Error: errKey, Message: msg})
}

// truncateUTF8 truncates s to at most max bytes, backing off to the
// nearest valid UTF-8 rune boundary to avoid producing invalid UTF-8.
func truncateUTF8(s string, max int) string {
	if max <= 0 || len(s) <= max {
		return s
	}
	s = s[:max]
	// Back off until we're at a valid rune boundary
	for len(s) > 0 && !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s
}

// ─── Main ─────────────────────────────────────────────────────────────────────

func main() {
	cfgPath := flag.String("config", "config.yaml", "path to config file")
	flag.Parse()

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	cfg := defaultConfig()
	if err := loadConfig(*cfgPath, &cfg); err != nil {
		logger.Error("failed to load config", "path", *cfgPath, "error", err)
		os.Exit(1)
	}

	if len(cfg.Tokens) == 0 {
		logger.Error("no tokens configured — refusing to start without auth")
		os.Exit(1)
	}

	srv, err := newServer(cfg, logger)
	if err != nil {
		logger.Error("failed to compile allowlist", "error", err)
		os.Exit(1)
	}

	addr := fmt.Sprintf("%s:%d", cfg.Bind, cfg.Port)
	logger.Info("being-exec starting", "addr", addr, "version", version, "patterns", len(cfg.Allow))
	if err := http.ListenAndServe(addr, srv); err != nil {
		logger.Error("server error", "error", err)
		os.Exit(1)
	}
}
