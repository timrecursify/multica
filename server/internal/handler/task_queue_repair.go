package handler

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// repairStatusValues are the statuses the operator repair list accepts as a
// filter value. They mirror the live status set (queued / dispatched /
// running / waiting_local_directory / deferred / completed / failed /
// cancelled) so a filter can never be an unbounded wildcard typo.
var repairStatusValues = map[string]bool{
	"queued":                  true,
	"dispatched":              true,
	"running":                 true,
	"waiting_local_directory": true,
	"deferred":                true,
	"completed":               true,
	"failed":                  true,
	"cancelled":               true,
}

// ListRepairableTasks is the read side of the operator repair surface
// (PPP-21291). Optional filters: status, daemon (daemon lane), older_than
// (Go duration, e.g. "24h"; cutoff computed server-side and compared with
// <= against COALESCE(started_at, dispatched_at, created_at)), and limit
// (1..500, default 100). Always bounded and deterministically ordered.
func (h *Handler) ListRepairableTasks(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	filter := service.TaskRepairFilter{MaxRows: 100}
	if ws := ctxWorkspaceID(r.Context()); ws != "" {
		_ = filter.WorkspaceID.Scan(ws)
	}

	if v := q.Get("status"); v != "" {
		if !repairStatusValues[v] {
			writeError(w, http.StatusBadRequest, "invalid status filter")
			return
		}
		filter.Status = v
	}
	if v := q.Get("daemon"); v != "" {
		filter.DaemonID = v
	}
	if v := q.Get("older_than"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			writeError(w, http.StatusBadRequest, "older_than must be a positive Go duration (e.g. 24h, 30m)")
			return
		}
		filter.OlderThan = pgtype.Timestamptz{Time: time.Now().Add(-d), Valid: true}
	}
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 500 {
			writeError(w, http.StatusBadRequest, "limit must be an integer in [1,500]")
			return
		}
		filter.MaxRows = int32(n)
	}

	rows, err := h.TaskService.ListRepairableTasks(r.Context(), filter)
	if err != nil {
		slog.Warn("list repairable tasks failed", "error", err)
		writeError(w, http.StatusInternalServerError, "list repairable tasks failed")
		return
	}

	tasks := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		tasks = append(tasks, repairableTaskJSON(row))
	}
	writeJSON(w, http.StatusOK, map[string]any{"tasks": tasks, "count": len(tasks)})
}

// repairableTaskJSON renders one list row. Timestamps are RFC3339 when set,
// null otherwise. The daemon identifier is runtime_id (the runtime the
// daemon incarnates); daemon_id is the optional routing-lane hint from
// migration 273.
func repairableTaskJSON(row db.ListRepairableAgentTasksRow) map[string]any {
	return map[string]any{
		"task_id":        uuidToString(row.ID),
		"status":         row.Status,
		"agent_id":       uuidOrNull(row.AgentID),
		"issue_id":       uuidOrNull(row.IssueID),
		"workspace_id":   uuidOrNull(row.WorkspaceID),
		"runtime_id":     uuidOrNull(row.RuntimeID),
		"daemon_id":      textOrNull(row.DaemonID),
		"attempt":        row.Attempt,
		"max_attempts":   row.MaxAttempts,
		"created_at":     row.CreatedAt,
		"dispatched_at":  row.DispatchedAt,
		"started_at":     row.StartedAt,
		"completed_at":   row.CompletedAt,
		"error":          textOrNull(row.Error),
		"failure_reason": textOrNull(row.FailureReason),
	}
}

// FailOrphanedTaskRequest is the fail verb body: the operator's reason is
// persisted as the visible error text and classified with the canonical
// platform-side failure_reason.
type FailOrphanedTaskRequest struct {
	Reason string `json:"reason"`
}

// FailOrphanedTask terminally fails ONE non-terminal task (operator repair).
func (h *Handler) FailOrphanedTask(w http.ResponseWriter, r *http.Request) {
	taskID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "taskId"), "taskId")
	if !ok {
		return
	}

	var req FailOrphanedTaskRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Reason == "" {
		writeError(w, http.StatusBadRequest, "reason required")
		return
	}

	previous, err := h.TaskService.FailOrphanedTask(r.Context(), taskID, req.Reason)
	if err != nil {
		h.writeRepairError(w, err)
		return
	}

	slog.Warn("operator repair: task failed",
		"task_id", uuidToString(taskID),
		"previous_status", previous.PreviousStatus,
		"failure_reason", service.RepairFailureReason,
		"reason", req.Reason,
	)
	writeJSON(w, http.StatusOK, map[string]any{
		"task_id":         uuidToString(previous.ID),
		"workspace_id":    uuidOrNull(previous.WorkspaceID),
		"previous_status": previous.PreviousStatus,
		"status":          "failed",
		"completed_at":    previous.CompletedAt,
		"updated_at":      time.Now().UTC(),
		"failure_reason":  service.RepairFailureReason,
		"replayed":        false,
	})
}

// RequeueOrphanedTask returns ONE orphaned in-flight task to the queue.
func (h *Handler) RequeueOrphanedTask(w http.ResponseWriter, r *http.Request) {
	taskID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "taskId"), "taskId")
	if !ok {
		return
	}

	previous, err := h.TaskService.RequeueOrphanedTask(r.Context(), taskID)
	if err != nil {
		h.writeRepairError(w, err)
		return
	}

	slog.Warn("operator repair: task requeued",
		"task_id", uuidToString(taskID),
		"previous_status", previous.PreviousStatus,
	)
	writeJSON(w, http.StatusOK, map[string]any{
		"task_id":                  uuidToString(previous.ID),
		"workspace_id":             uuidOrNull(previous.WorkspaceID),
		"previous_status":          previous.PreviousStatus,
		"status":                   "queued",
		"updated_at":               time.Now().UTC(),
		"created_at":               previous.CreatedAt,
		"dispatched_at":            previous.DispatchedAt,
		"started_at":               previous.StartedAt,
		"prepare_lease_expires_at": previous.PrepareLeaseExpiresAt,
		"daemon_id":                textOrNull(previous.DaemonID),
		"replayed":                 false,
	})
}

// writeRepairError maps the repair service's typed errors to HTTP responses:
// 404 for a missing task, 409 with a machine code for CAS misses and
// live-slot conflicts, 500 for anything else.
func (h *Handler) writeRepairError(w http.ResponseWriter, err error) {
	var conflict *service.RepairConflictError
	var slotTaken *service.RepairLiveSlotTakenError
	switch {
	case errors.Is(err, service.ErrRepairTaskNotFound):
		writeErrorCode(w, http.StatusNotFound, "task_not_found", err.Error())
	case errors.As(err, &conflict):
		writeErrorCode(w, http.StatusConflict, "task_not_repairable", conflict.Error())
	case errors.As(err, &slotTaken):
		writeErrorCode(w, http.StatusConflict, "live_task_conflict", slotTaken.Error())
	default:
		slog.Warn("task queue repair failed", "error", err)
		writeError(w, http.StatusInternalServerError, err.Error())
	}
}

func uuidOrNull(u pgtype.UUID) any {
	if !u.Valid {
		return nil
	}
	return uuidToString(u)
}

func textOrNull(t pgtype.Text) any {
	if !t.Valid {
		return nil
	}
	return t.String
}
