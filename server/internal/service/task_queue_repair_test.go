package service

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// repairTaskFixture seeds a workspace -> runtime -> agent -> issue -> task
// chain and returns the task id. status and daemon lane are caller-chosen so
// each test can exercise a specific CAS branch.
func repairTaskFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool, status, daemonID string) string {
	t.Helper()
	suffix := time.Now().UnixNano()

	var userID string
	if err := pool.QueryRow(ctx, `INSERT INTO "user" (name, email) VALUES ($1,$2) RETURNING id`,
		"Repair Test", fmt.Sprintf("repair-%d@multica.ai", suffix)).Scan(&userID); err != nil {
		t.Fatalf("create user: %v", err)
	}
	var workspaceID string
	if err := pool.QueryRow(ctx, `INSERT INTO workspace (name, slug, description, issue_prefix) VALUES ($1,$2,$3,$4) RETURNING id`,
		"Repair Test", fmt.Sprintf("repair-%d", suffix), "temp repair test", "RPR").Scan(&workspaceID); err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO member (workspace_id, user_id, role) VALUES ($1,$2,'owner')`, workspaceID, userID); err != nil {
		t.Fatalf("create member: %v", err)
	}
	var runtimeID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agent_runtime (workspace_id, daemon_id, name, runtime_mode, provider, status, device_info, metadata, last_seen_at, visibility, owner_id)
		VALUES ($1, 'daemon-repair', 'Repair RT', 'cloud', 'repair_provider', 'online', 'x', '{}'::jsonb, now(), 'private', $2)
		RETURNING id`, workspaceID, userID).Scan(&runtimeID); err != nil {
		t.Fatalf("create runtime: %v", err)
	}
	var agentID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agent (workspace_id, name, description, runtime_mode, runtime_config, runtime_id, visibility, max_concurrent_tasks, owner_id)
		VALUES ($1, $2, '', 'cloud', '{}'::jsonb, $3, 'private', 5, $4)
		RETURNING id`, workspaceID, fmt.Sprintf("Repair Agent %d", suffix), runtimeID, userID).Scan(&agentID); err != nil {
		t.Fatalf("create agent: %v", err)
	}
	var issueID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO issue (workspace_id, title, status, priority, creator_id, creator_type, number, position)
		VALUES ($1, 'repair issue', 'in_progress', 'none', $2, 'member', 700001, 0)
		RETURNING id`, workspaceID, userID).Scan(&issueID); err != nil {
		t.Fatalf("create issue: %v", err)
	}
	var taskID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agent_task_queue (agent_id, runtime_id, issue_id, status, priority, context, dispatched_at, started_at, daemon_id)
		VALUES ($1, $2, $3, $4, 0, '{}'::jsonb, now(), now(), $5)
		RETURNING id`, agentID, runtimeID, issueID, status, daemonID).Scan(&taskID); err != nil {
		t.Fatalf("create task: %v", err)
	}

	t.Cleanup(func() {
		c := context.Background()
		pool.Exec(c, `DELETE FROM agent_task_queue WHERE id = $1`, taskID)
		pool.Exec(c, `DELETE FROM issue WHERE id = $1`, issueID)
		pool.Exec(c, `DELETE FROM agent WHERE id = $1`, agentID)
		pool.Exec(c, `DELETE FROM agent_runtime WHERE id = $1`, runtimeID)
		pool.Exec(c, `DELETE FROM member WHERE workspace_id = $1 AND user_id = $2`, workspaceID, userID)
		pool.Exec(c, `DELETE FROM workspace WHERE id = $1`, workspaceID)
		pool.Exec(c, `DELETE FROM "user" WHERE id = $1`, userID)
	})
	return taskID
}

func newRepairService(t *testing.T, pool *pgxpool.Pool) *TaskService {
	t.Helper()
	return NewTaskService(db.New(pool), pool, nil, events.New())
}

func TestFailOrphanedTaskMarksNonTerminalTaskFailed(t *testing.T) {
	ctx := context.Background()
	pool := newTaskClaimRacePool(t)
	svc := newRepairService(t, pool)

	taskID := repairTaskFixture(t, ctx, pool, "running", "lane-a")
	task, err := svc.FailOrphanedTask(ctx, util.MustParseUUID(taskID), "postgres outage left row orphaned (PPP-21278)")
	if err != nil {
		t.Fatalf("fail orphaned task: %v", err)
	}
	if task.Status != "failed" {
		t.Fatalf("status = %s, want failed", task.Status)
	}
	if !task.CompletedAt.Valid {
		t.Fatal("completed_at not stamped")
	}
	if task.FailureReason.String != RepairFailureReason {
		t.Fatalf("failure_reason = %q, want %q", task.FailureReason.String, RepairFailureReason)
	}
	if task.Error.String != "postgres outage left row orphaned (PPP-21278)" {
		t.Fatalf("error = %q, want the operator reason", task.Error.String)
	}
	if task.PrepareLeaseExpiresAt.Valid {
		t.Fatal("prepare lease not cleared")
	}

	// No retry child may be created by a manual repair.
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM agent_task_queue WHERE issue_id = (SELECT issue_id FROM agent_task_queue WHERE id = $1)`, taskID).Scan(&count); err != nil {
		t.Fatalf("count tasks: %v", err)
	}
	if count != 1 {
		t.Fatalf("task count for issue = %d, want 1 (no auto-retry child)", count)
	}
}

func TestFailOrphanedTaskConflictWhenAlreadyTerminal(t *testing.T) {
	ctx := context.Background()
	pool := newTaskClaimRacePool(t)
	svc := newRepairService(t, pool)

	taskID := repairTaskFixture(t, ctx, pool, "failed", "")
	_, err := svc.FailOrphanedTask(ctx, util.MustParseUUID(taskID), "already dead")
	var conflict *RepairConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("expected RepairConflictError, got %v", err)
	}
	if conflict.CurrentStatus != "failed" {
		t.Fatalf("current_status = %q, want failed", conflict.CurrentStatus)
	}
	if conflict.Action != "fail" {
		t.Fatalf("action = %q, want fail", conflict.Action)
	}
}

func TestFailOrphanedTaskNotFound(t *testing.T) {
	ctx := context.Background()
	pool := newTaskClaimRacePool(t)
	svc := newRepairService(t, pool)

	_, err := svc.FailOrphanedTask(ctx, util.MustParseUUID("99999999-9999-4999-8999-999999999999"), "gone")
	if !errors.Is(err, ErrRepairTaskNotFound) {
		t.Fatalf("expected ErrRepairTaskNotFound, got %v", err)
	}
}

func TestRequeueOrphanedTaskReturnsRunningTaskToQueue(t *testing.T) {
	ctx := context.Background()
	pool := newTaskClaimRacePool(t)
	svc := newRepairService(t, pool)

	taskID := repairTaskFixture(t, ctx, pool, "running", "lane-a")
	if _, err := pool.Exec(ctx, `UPDATE agent_task_queue SET prepare_lease_expires_at = now() - interval '1 minute' WHERE id = $1`, taskID); err != nil {
		t.Fatalf("arm lease: %v", err)
	}

	task, err := svc.RequeueOrphanedTask(ctx, util.MustParseUUID(taskID))
	if err != nil {
		t.Fatalf("requeue orphaned task: %v", err)
	}
	if task.Status != "queued" {
		t.Fatalf("status = %s, want queued", task.Status)
	}
	if task.DispatchedAt.Valid || task.StartedAt.Valid {
		t.Fatalf("execution stamps not cleared: dispatched=%v started=%v", task.DispatchedAt.Valid, task.StartedAt.Valid)
	}
	if task.PrepareLeaseExpiresAt.Valid {
		t.Fatal("prepare lease not cleared")
	}
	if task.DaemonID.Valid {
		t.Fatalf("daemon lane not cleared: %q", task.DaemonID.String)
	}
	if task.Attempt != 1 {
		t.Fatalf("attempt = %d, want preserved 1", task.Attempt)
	}
	// runtime_id must survive: the active-requires-runtime CHECK demands it.
	if !task.RuntimeID.Valid {
		t.Fatal("runtime_id cleared; active row must keep it")
	}
}

func TestRequeueOrphanedTaskConflictWhenQueued(t *testing.T) {
	ctx := context.Background()
	pool := newTaskClaimRacePool(t)
	svc := newRepairService(t, pool)

	taskID := repairTaskFixture(t, ctx, pool, "queued", "")
	_, err := svc.RequeueOrphanedTask(ctx, util.MustParseUUID(taskID))
	var conflict *RepairConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("expected RepairConflictError, got %v", err)
	}
	if conflict.CurrentStatus != "queued" {
		t.Fatalf("current_status = %q, want queued", conflict.CurrentStatus)
	}
}

func TestRequeueOrphanedTaskLiveSlotTaken(t *testing.T) {
	ctx := context.Background()
	pool := newTaskClaimRacePool(t)
	svc := newRepairService(t, pool)

	// A task in waiting_local_directory is NOT covered by
	// uq_agent_task_queue_live_issue (queued|dispatched|running only), so a
	// newer queued row can legitimately hold the issue's live slot. Requeueing
	// the waiting row must then 409 instead of creating a duplicate live row.
	taskID := repairTaskFixture(t, ctx, pool, "waiting_local_directory", "lane-a")

	var issueID string
	if err := pool.QueryRow(ctx, `SELECT issue_id FROM agent_task_queue WHERE id = $1`, taskID).Scan(&issueID); err != nil {
		t.Fatalf("load issue id: %v", err)
	}
	var secondID string
	if err := pool.QueryRow(ctx, `INSERT INTO agent_task_queue (agent_id, runtime_id, issue_id, status, priority, context)
		SELECT agent_id, runtime_id, issue_id, 'queued', 0, '{}'::jsonb FROM agent_task_queue WHERE id = $1
		RETURNING id`, taskID).Scan(&secondID); err != nil {
		t.Fatalf("create competing live task: %v", err)
	}
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE id = $1`, secondID) })

	_, err := svc.RequeueOrphanedTask(ctx, util.MustParseUUID(taskID))
	var slotTaken *RepairLiveSlotTakenError
	if !errors.As(err, &slotTaken) {
		t.Fatalf("expected RepairLiveSlotTakenError, got %v", err)
	}
	if slotTaken.IssueID != issueID {
		t.Fatalf("issue_id = %q, want %q", slotTaken.IssueID, issueID)
	}
}

func TestListRepairableTasksFilters(t *testing.T) {
	ctx := context.Background()
	pool := newTaskClaimRacePool(t)
	svc := newRepairService(t, pool)

	runningID := repairTaskFixture(t, ctx, pool, "running", "lane-a")
	queuedID := repairTaskFixture(t, ctx, pool, "queued", "")

	// Status filter.
	rows, err := svc.ListRepairableTasks(ctx, TaskRepairFilter{Status: "running", MaxRows: 10})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(rows) != 1 || util.UUIDToString(rows[0].ID) != runningID {
		t.Fatalf("status filter returned %+v, want only %s", rows, runningID)
	}

	// Daemon filter.
	rows, err = svc.ListRepairableTasks(ctx, TaskRepairFilter{DaemonID: "lane-a", MaxRows: 10})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(rows) != 1 || util.UUIDToString(rows[0].ID) != runningID {
		t.Fatalf("daemon filter returned %+v, want only %s", rows, runningID)
	}

	// Age filter: a cutoff an hour in the past excludes freshly created rows.
	rows, err = svc.ListRepairableTasks(ctx, TaskRepairFilter{
		OlderThan: pgtype.Timestamptz{Time: time.Now().Add(-time.Hour), Valid: true},
		MaxRows:   10,
	})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("age filter returned %d rows, want 0", len(rows))
	}

	// No filter returns both, capped.
	rows, err = svc.ListRepairableTasks(ctx, TaskRepairFilter{MaxRows: 10})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	found := map[string]bool{}
	for _, r := range rows {
		found[util.UUIDToString(r.ID)] = true
	}
	if !found[runningID] || !found[queuedID] {
		t.Fatalf("unfiltered list missing fixtures: %+v", found)
	}
}
