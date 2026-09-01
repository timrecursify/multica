package daemon

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProbeAgentCLIsAllowlistRestrictsProviders(t *testing.T) {
	root := t.TempDir()
	codex := filepath.Join(root, "codex")
	claude := filepath.Join(root, "claude")
	for _, path := range []string{codex, claude} {
		if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, env := range []string{
		"MULTICA_OPENCODE_PATH", "MULTICA_DEVECO_PATH", "MULTICA_OPENCLAW_PATH",
		"MULTICA_HERMES_PATH", "MULTICA_PI_PATH", "MULTICA_OMP_PATH",
		"MULTICA_CURSOR_PATH", "MULTICA_COPILOT_PATH", "MULTICA_KIMI_PATH",
		"MULTICA_REASONIX_PATH", "MULTICA_KIRO_PATH", "MULTICA_CODEBUDDY_PATH",
		"MULTICA_ANTIGRAVITY_PATH", "MULTICA_QODER_PATH", "MULTICA_QODERCLICN_PATH",
		"MULTICA_TRAECLI_PATH", "MULTICA_GROK_PATH", "MULTICA_QWEN_PATH",
		"MULTICA_QWENPAW_PATH",
	} {
		t.Setenv(env, filepath.Join(root, "missing-"+env))
	}
	t.Setenv("PATH", root)
	t.Setenv("MULTICA_CODEX_PATH", codex)
	t.Setenv("MULTICA_CLAUDE_PATH", claude)
	t.Setenv("MULTICA_DAEMON_ALLOWED_PROVIDERS", " codex ")

	agents := probeAgentCLIs()
	if len(agents) != 1 {
		t.Fatalf("discovered providers = %#v, want only codex", agents)
	}
	if _, ok := agents["codex"]; !ok {
		t.Fatalf("discovered providers = %#v, want codex", agents)
	}
}

func TestConfiguredAgentAllowlistBlankKeepsDiscoveryUnfiltered(t *testing.T) {
	t.Setenv("MULTICA_DAEMON_ALLOWED_PROVIDERS", "  ")
	if got := configuredAgentAllowlist(); got != nil {
		t.Fatalf("blank allowlist = %#v, want nil", got)
	}
}
