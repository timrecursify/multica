package service

import (
	"strings"
	"testing"
	"time"
)

// TestLaneRateLimitDecision covers the pure decision half of the lane health
// gate (PPP-21346): a lane pauses only after a burst of provider rate-limit
// failures whose most recent one is still inside the cooldown, and resumes on
// its own once the cooldown elapses.
func TestLaneRateLimitDecision(t *testing.T) {
	now := time.Date(2026, 8, 26, 17, 3, 30, 0, time.UTC)
	recent := now.Add(-2 * time.Minute)          // within the cooldown
	stale := now.Add(-laneRateLimitCooldown - 1) // cooldown already elapsed

	t.Run("below threshold never pauses", func(t *testing.T) {
		if paused, reason := laneRateLimitDecision(1, recent, now); paused {
			t.Fatalf("single transient 429 paused the lane: %q", reason)
		}
	})

	t.Run("burst within cooldown pauses with a stable reason", func(t *testing.T) {
		paused, reason := laneRateLimitDecision(3, recent, now)
		if !paused {
			t.Fatal("rate-limit burst within cooldown did not pause the lane")
		}
		if !strings.HasPrefix(reason, "agent lane rate-limited (429):") {
			t.Fatalf("reason lost the stable prefix: %q", reason)
		}
		wantUntil := recent.Add(laneRateLimitCooldown).UTC().Format(time.RFC3339)
		if !strings.Contains(reason, "paused until "+wantUntil) {
			t.Fatalf("reason does not name the pause window %s: %q", wantUntil, reason)
		}
	})

	t.Run("burst with cooldown elapsed resumes", func(t *testing.T) {
		if paused, reason := laneRateLimitDecision(3, stale, now); paused {
			t.Fatalf("lane still paused after cooldown elapsed: %q", reason)
		}
	})

	t.Run("zero failures never pauses", func(t *testing.T) {
		if paused, reason := laneRateLimitDecision(0, recent, now); paused {
			t.Fatalf("zero failures paused the lane: %q", reason)
		}
	})
}
