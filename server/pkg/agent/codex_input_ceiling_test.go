package agent

import (
	"strings"
	"testing"
)

// Fixture (a) — "a >2M context". A run whose cumulative input-side tokens
// exceed the configured ceiling must abort with an actionable failure reason
// rather than keep burning provider tokens (PROD-22899).
func TestCodexInputCeilingFailsActionably(t *testing.T) {
	c := &codexClient{maxInputTokens: 2_000_000}

	// Turn 1: 1.5M input tokens, 0.5M of which are cached reads.
	//   cumulative = (1.5M - 0.5M) uncached + 0.5M cached = 1.5M  (< 2M)
	c.extractUsageFromMap(map[string]any{
		"usage": map[string]any{
			"input_tokens":        float64(1_500_000),
			"cached_input_tokens": float64(500_000),
			"output_tokens":       float64(100),
		},
	})
	if got := c.getTurnError(); got != "" {
		t.Fatalf("under ceiling should not set a turn error, got %q", got)
	}

	// Turn 2 pushes the cumulative input over 2M (1.5M + 0.8M = 2.3M).
	c.extractUsageFromMap(map[string]any{
		"usage": map[string]any{
			"input_tokens":  float64(800_000),
			"output_tokens": float64(100),
		},
	})
	got := c.getTurnError()
	if got == "" {
		t.Fatal("expected an actionable failure reason once cumulative input exceeds the ceiling")
	}
	if !strings.Contains(got, "ceiling") || !strings.Contains(got, "split the task") {
		t.Fatalf("message should be actionable and name the ceiling, got %q", got)
	}
}

// A zero ceiling disables the guard entirely (operators opt out explicitly).
func TestCodexInputCeilingDisabled(t *testing.T) {
	c := &codexClient{maxInputTokens: 0}
	c.extractUsageFromMap(map[string]any{
		"usage": map[string]any{"input_tokens": float64(50_000_000)},
	})
	if got := c.getTurnError(); got != "" {
		t.Fatalf("disabled ceiling must never set a turn error, got %q", got)
	}
}

func TestCumulativeInputTokens(t *testing.T) {
	u := TokenUsage{InputTokens: 1_000_000, CacheReadTokens: 500_000, CacheWriteTokens: 100_000}
	if got := cumulativeInputTokens(u); got != 1_600_000 {
		t.Fatalf("cumulativeInputTokens() = %d, want 1600000", got)
	}
}
