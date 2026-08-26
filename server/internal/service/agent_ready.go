package service

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Lane rate-limit health gate (PPP-21346). A lane whose recent tasks are
// failing with provider rate-limit/capacity errors (429) is paused for new
// dispatch until the cooldown elapses, instead of the dispatcher enqueueing
// tasks that fail instantly with "exceeded retry limit, 429". The window and
// cooldown are deliberately conservative: a single transient 429 never pauses
// a lane, and a paused lane resumes on its own once the provider recovers.
const (
	laneRateLimitWindow    = 15 * time.Minute
	laneRateLimitThreshold = 2
	laneRateLimitCooldown  = 10 * time.Minute
)

// laneRateLimitDecision is the pure decision half of the lane health gate so
// it can be unit-tested without a database. It reports whether the agent's
// lane is paused right now (failureCount rate-limit failures whose most recent
// one is within the cooldown), and the reason phrasing when paused.
func laneRateLimitDecision(failureCount int, lastFailureAt, now time.Time) (bool, string) {
	if failureCount < laneRateLimitThreshold {
		return false, ""
	}
	if now.Sub(lastFailureAt) >= laneRateLimitCooldown {
		return false, ""
	}
	pausedUntil := lastFailureAt.Add(laneRateLimitCooldown)
	return true, fmt.Sprintf(
		"agent lane rate-limited (429): %d provider rate-limit failures in the last %s, paused until %s",
		failureCount, laneRateLimitWindow, pausedUntil.UTC().Format(time.RFC3339))
}

// AgentRateLimitPaused reports whether an agent's lane is currently paused by
// the rate-limit health gate. err is non-nil only on a DB lookup failure for
// the failure-history query; callers that treat a transient DB error as "do
// not skip" (the autopilot admission gate) should swallow it, callers that
// need a hard yes/no (the squad-leader pre-enqueue check, issue-assign gates)
// should fail closed.
func AgentRateLimitPaused(ctx context.Context, q *db.Queries, agentID pgtype.UUID) (bool, string, error) {
	row, err := q.GetAgentRecentRateLimitFailures(ctx, db.GetAgentRecentRateLimitFailuresParams{
		AgentID:     agentID,
		CompletedAt: pgtype.Timestamptz{Time: time.Now().Add(-laneRateLimitWindow), Valid: true},
	})
	if err != nil {
		return false, "", err
	}
	if !row.LastFailureAt.Valid {
		return false, "", nil
	}
	paused, reason := laneRateLimitDecision(int(row.FailureCount), row.LastFailureAt.Time, time.Now())
	return paused, reason, nil
}

// AgentReadiness reports whether an agent can accept new work right now.
// "Ready" means archived_at IS NULL, runtime_id IS NOT NULL, the bound
// runtime's status is 'online', and the lane is not paused by the rate-limit
// health gate (PPP-21346). When not ready, reason describes which gate failed
// in language suitable for autopilot_run.failure_reason.
//
// err is non-nil only on DB lookup failure for the runtime row. Callers that
// treat a transient DB error as "do not skip" (the autopilot admission gate)
// should swallow it; callers that need a hard yes/no (the squad-leader
// pre-enqueue check in the handler) should fail closed.
//
// This is the single source of truth shared by:
//   - service.shouldSkipDispatch (autopilot admission gate)
//   - service.dispatchRunOnly    (squad-leader runtime check, MUL-2429)
//   - handler.isSquadLeaderReady (issue-assign / comment-trigger path)
//
// Keeping these aligned matters because the three paths can otherwise drift
// — e.g. one starts allowing "starting" runtimes while another doesn't, and
// the bug only surfaces when a user assigns the same squad through two
// different entry points. Touch this function, all three paths move together.
func AgentReadiness(ctx context.Context, q *db.Queries, agent db.Agent) (ready bool, reason string, err error) {
	if agent.ArchivedAt.Valid {
		return false, "agent is archived", nil
	}
	if !agent.RuntimeID.Valid {
		return false, "agent has no runtime bound", nil
	}
	rt, err := q.GetAgentRuntime(ctx, agent.RuntimeID)
	if err != nil {
		return false, "", err
	}
	if rt.Status != "online" {
		return false, "agent runtime is " + rt.Status, nil
	}
	paused, reason, err := AgentRateLimitPaused(ctx, q, agent.ID)
	if err != nil {
		return false, "", err
	}
	if paused {
		return false, reason, nil
	}
	return true, "", nil
}
