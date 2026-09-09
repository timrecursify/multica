package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// RepairFailureReason is the canonical platform-side failure_reason written by
// the manual operator repair verb (PPP-21291). It is deliberately NOT part of
// the taskfailure agent-error taxonomy: the value is written directly (like
// 'runtime_recovery'), never produced by taskfailure.Classify, and it is not
// in retryableReasons so the repair can never spawn an auto-retry child.
const RepairFailureReason = "operator_orphan_repair"

// ErrRepairTaskNotFound is returned when a repair verb targets a task id that
// does not exist (or no longer exists). Handlers map it to 404.
var ErrRepairTaskNotFound = errors.New("repair: task not found")

// RepairConflictError reports a CAS miss: the target task exists but is not in
// a state the requested repair verb may act on. Handlers map it to 409 so an
// operator never sees a silent no-op and never double-runs a task.
type RepairConflictError struct {
	TaskID        string
	Action        string
	CurrentStatus string
}

func (e *RepairConflictError) Error() string {
	return fmt.Sprintf("repair: cannot %s task %s: current status %q is not repairable",
		e.Action, e.TaskID, e.CurrentStatus)
}

// RepairLiveSlotTakenError is returned by requeue when the task's issue already
// has a live (queued/dispatched/running) row: uq_agent_task_queue_live_issue
// forbids a second live row, and the repair must never cancel or replace the
// other row. Handlers map it to 409.
type RepairLiveSlotTakenError struct {
	TaskID  string
	IssueID string
}

func (e *RepairLiveSlotTakenError) Error() string {
	return fmt.Sprintf("repair: cannot requeue task %s: issue %s already has a live task",
		e.TaskID, e.IssueID)
}

// TaskRepairFilter carries the optional list filters. Empty values mean "no
// filter". OlderThan is a server-side cutoff already parsed by the handler;
// the comparison includes the cutoff (<=).
type TaskRepairFilter struct {
	WorkspaceID pgtype.UUID
	Status    string
	DaemonID  string
	OlderThan pgtype.Timestamptz
	MaxRows   int32
}

// ListRepairableTasks is the read side of the operator repair surface. It is a
// bounded, deterministic incident-scale read: optional status / daemon / age
// filters and a hard row cap, ordered oldest effective activity first.
func (s *TaskService) ListRepairableTasks(ctx context.Context, f TaskRepairFilter) ([]db.ListRepairableAgentTasksRow, error) {
	if f.MaxRows <= 0 {
		f.MaxRows = 100
	}
	return s.Queries.ListRepairableAgentTasks(ctx, db.ListRepairableAgentTasksParams{
		WorkspaceID: f.WorkspaceID,
		Status:    pgtype.Text{String: f.Status, Valid: f.Status != ""},
		DaemonID:  pgtype.Text{String: f.DaemonID, Valid: f.DaemonID != ""},
		OlderThan: f.OlderThan,
		MaxRows:   f.MaxRows,
	})
}

func workspaceFromContext(ctx context.Context) pgtype.UUID {
	var id pgtype.UUID
	_ = id.Scan(middleware.WorkspaceIDFromContext(ctx))
	return id
}

// FailOrphanedTask terminally fails ONE non-terminal task without the
// auto-retry / chat-session side effects of FailTask. reason is the operator's
// explanation and is persisted as both the visible error text and the
// canonical platform-side failure_reason (unless the caller already supplied a
// classification). The status predicate is the compare-and-swap: an already
// terminal (or missing) task returns a conflict / not-found error instead of
// fabricating a transition.
func (s *TaskService) FailOrphanedTask(ctx context.Context, taskID pgtype.UUID, reason string) (*db.FailOrphanedAgentTaskRow, error) {
	classification := RepairFailureReason
	if reason == "" {
		return nil, errors.New("repair: fail requires a reason")
	}
	task, err := s.Queries.FailOrphanedAgentTask(ctx, db.FailOrphanedAgentTaskParams{
		TaskID:        taskID,
		WorkspaceID:   workspaceFromContext(ctx),
		Error:         reason,
		FailureReason: classification,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, s.repairConflict(ctx, taskID, "fail")
		}
		return nil, fmt.Errorf("fail orphaned task: %w", err)
	}
	return &task, nil
}

// RequeueOrphanedTask returns ONE orphaned in-flight task to the queue,
// clearing the execution stamps, prepare lease, and daemon lane so it can be
// claimed and run again. attempt is preserved (same unexecuted attempt, not a
// retry child). A conflicting live row for the same issue yields
// RepairLiveSlotTakenError; a task no longer in an in-flight state yields a
// conflict / not-found error.
func (s *TaskService) RequeueOrphanedTask(ctx context.Context, taskID pgtype.UUID) (*db.RequeueOrphanedAgentTaskRow, error) {
	task, err := s.Queries.RequeueOrphanedAgentTask(ctx, db.RequeueOrphanedAgentTaskParams{TaskID: taskID, WorkspaceID: workspaceFromContext(ctx)})
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return nil, s.liveSlotTaken(ctx, taskID)
		}
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, s.repairConflict(ctx, taskID, "requeue")
		}
		return nil, fmt.Errorf("requeue orphaned task: %w", err)
	}
	return &task, nil
}

// repairConflict resolves a zero-row CAS miss into the typed error: 404 when
// the task is gone, otherwise a conflict carrying the current status.
func (s *TaskService) repairConflict(ctx context.Context, taskID pgtype.UUID, action string) error {
	existing, err := s.Queries.GetAgentTask(ctx, taskID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrRepairTaskNotFound
		}
		return fmt.Errorf("repair: load task for conflict: %w", err)
	}
	return &RepairConflictError{
		TaskID:        util.UUIDToString(taskID),
		Action:        action,
		CurrentStatus: existing.Status,
	}
}

// liveSlotTaken resolves a unique-violation on requeue into the typed error.
func (s *TaskService) liveSlotTaken(ctx context.Context, taskID pgtype.UUID) error {
	existing, err := s.Queries.GetAgentTask(ctx, taskID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrRepairTaskNotFound
		}
		return fmt.Errorf("repair: load task for live-slot conflict: %w", err)
	}
	issueID := ""
	if existing.IssueID.Valid {
		issueID = util.UUIDToString(existing.IssueID)
	}
	return &RepairLiveSlotTakenError{TaskID: util.UUIDToString(taskID), IssueID: issueID}
}
