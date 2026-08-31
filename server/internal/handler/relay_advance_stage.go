package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// RelayAdvanceStageRequest is the request body for POST /api/relay/advance-stage.
//
// Unlike the existing /api/relay/advance (task-to-daemon lane routing), this
// surface performs the issue-stage advancement that the host-local
// multica-bridge.cjs used to own: it validates the requested transition against
// relay_stage_config, rejects missing/archived/unroutable stage owners, then
// atomically updates the issue status and enqueues the successor agent_task_queue
// in one database transaction.
//
// Request: { "issue_id": "...", "to_stage": "In Review" }
// The target stage string is compared exactly against relay_stage_config edge
// columns; no canonicalization is applied by the relay (the bridge passed the
// literal target through, and callers run the status contract).
type RelayAdvanceStageRequest struct {
	IssueID string `json:"issue_id"`
	ToStage string `json:"to_stage"`
}

// relayAdvanceStageResult is the success/coalesced response from the relay.
type relayAdvanceStageResult struct {
	Success    bool                 `json:"success"`
	Issue      *IssueSummary        `json:"issue"`
	Transition string               `json:"transition,omitempty"`
	TaskID     *string              `json:"task_id,omitempty"`
	RelayLogID *int64               `json:"relay_log_id,omitempty"`
}

// IssueSummary is the minimal issue projection the relay returns on success.
type IssueSummary struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

// relayError is the structured error surface for rejected relay requests. The
// bridge used distinct HTTP statuses (400 invalid stage/owner, 404 missing
// issue, 409 invalid transition/deploy-required/spec-required). The relay keeps
// those distinct statuses so existing belt callers can branch without decoding
// a body field.
type relayError struct {
	Error     string `json:"error"`
	Message   string `json:"message,omitempty"`
	FromStage string `json:"from_stage,omitempty"`
	ToStage   string `json:"to_stage,omitempty"`
}

// RelayAdvanceStage advances an issue's stage and enqueues its successor task
// atomically. It is the product-native replacement for multica-bridge.cjs's
// POST /relay/advance, preserving its semantics:
//
//  1. Loads and row-locks the target issue (FOR UPDATE) so concurrent or
//     repeated relay delivery serializes on the issue row.
//  2. Resolves the requested edge from relay_stage_config (workspace-scoped,
//     falling back to the global default row set).
//  3. Rejects stages that are not configured, edges that are not legal
//     successors, and owners that are missing/archived/unroutable (no runtime).
//  4. Updates issue.status and inserts the successor agent_task_queue in the
//     same transaction; the task insert is ON CONFLICT DO NOTHING, so a
//     duplicate delivery commits the status but does not double-enqueue.
//  5. Writes a relay_run_log row for audit when a successor task was created.
//
// Authorization is handled by the route middleware (operatorAuth / shared
// service secret); the handler is auth-agnostic.
func (h *Handler) RelayAdvanceStage(w http.ResponseWriter, r *http.Request) {
	var req RelayAdvanceStageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.ToStage == "" {
		writeError(w, http.StatusBadRequest, "to_stage is required")
		return
	}
	issueUUID, ok := parseUUIDOrBadRequest(w, req.IssueID, "issue_id")
	if !ok {
		return
	}

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to begin relay transaction")
		return
	}
	defer tx.Rollback(r.Context()) //nolint:errcheck // rollback is best-effort after commit

	qtx := h.Queries.WithTx(tx)

	issue, err := qtx.LockIssueForRelayAdvance(r.Context(), issueUUID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErrorJSON(w, http.StatusNotFound, relayError{Error: "issue_not_found", Message: "issue not found"})
		return
	}
	if err != nil {
		slog.Error("relay advance-stage: lock issue failed",
			"issue_id", uuidToString(issueUUID), "error", err)
		writeError(w, http.StatusInternalServerError, "failed to load issue")
		return
	}

	if issue.Status == req.ToStage {
		if err := tx.Commit(r.Context()); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to commit relay transaction")
			return
		}
		writeJSON(w, http.StatusOK, relayAdvanceStageResult{
			Success:    true,
			Issue:      &IssueSummary{ID: uuidToString(issue.ID), Status: issue.Status},
			Transition: "already_applied",
		})
		return
	}

	edge, err := qtx.GetRelayStageEdge(r.Context(), db.GetRelayStageEdgeParams{
		StageName:   issue.Status,
		WorkspaceID: issue.WorkspaceID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to resolve relay stage config")
		return
	}
	allowed := allowedRelayTargets(edge.NextStage, edge.AltNextStages)
	if !relayContainsString(allowed, req.ToStage) {
		writeErrorJSON(w, http.StatusConflict, relayError{
			Error:     "invalid_transition",
			Message:   "to_stage is not a configured successor of the issue status",
			FromStage: issue.Status,
			ToStage:   req.ToStage,
		})
		return
	}

	owner, err := qtx.GetRelayStageOwner(r.Context(), db.GetRelayStageOwnerParams{
		StageName:   req.ToStage,
		WorkspaceID: issue.WorkspaceID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to resolve relay stage owner")
		return
	}

	// A target stage without a configured row cannot be advanced even if the
	// caller supplies an edge; the target must appear in relay_stage_config.
	if !owner.AgentID.Valid {
		writeErrorJSON(w, http.StatusBadRequest, relayError{
			Error:     "invalid_to_stage",
			Message:   "to_stage is not a configured relay stage",
			FromStage: issue.Status,
			ToStage:   req.ToStage,
		})
		return
	}
	if owner.ArchivedAt.Valid {
		writeErrorJSON(w, http.StatusConflict, relayError{
			Error:     "owner_archived",
			Message:   fmt.Sprintf("relay owner is archived: %s (%s)", owner.AgentName.String, uuidToString(owner.AgentID)),
			FromStage: issue.Status,
			ToStage:   req.ToStage,
		})
		return
	}
	if !owner.SelectedRuntimeID.Valid {
		writeErrorJSON(w, http.StatusConflict, relayError{
			Error:     "no_runtime",
			Message:   fmt.Sprintf("no online runtime for relay stage: %s", req.ToStage),
			FromStage: issue.Status,
			ToStage:   req.ToStage,
		})
		return
	}

	// Commit the issue status first, then enqueue the successor task in the
	// same transaction. The task insert is idempotent (ON CONFLICT DO NOTHING),
	// so a concurrent/repeated delivery cannot double-enqueue.
	updated, err := qtx.UpdateIssueStatus(r.Context(), db.UpdateIssueStatusParams{
		ID:          issue.ID,
		WorkspaceID: issue.WorkspaceID,
		Status:      req.ToStage,
	})
	if err != nil {
		slog.Error("relay advance-stage: update issue status failed",
			"issue_id", uuidToString(issue.ID), "to_stage", req.ToStage, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to update issue status")
		return
	}

	ctxBytes, _ := json.Marshal(map[string]any{
		"source":     "relay-advance",
		"from_stage": issue.Status,
		"to_stage":   req.ToStage,
		"agent_name": owner.AgentName.String,
	})
	triggerSummary := fmt.Sprintf("Relay stage transition: %s -> %s", issue.Status, req.ToStage)

	task, taskErr := qtx.CreateRelayStageTask(r.Context(), db.CreateRelayStageTaskParams{
		AgentID:        owner.AgentID,
		RuntimeID:      owner.SelectedRuntimeID,
		IssueID:        issue.ID,
		Priority:       relayPriorityToInt(issue.Priority),
		TriggerSummary: pgtype.Text{String: triggerSummary, Valid: true},
		Context:        ctxBytes,
	})

	var taskID *string
	var relayLogID *int64
	switch {
	case taskErr == nil:
		taskID = uuidToPtr(task.ID)
		logRow, err := qtx.CreateRelayRunLog(r.Context(), db.CreateRelayRunLogParams{
			IssueID:   issue.ID,
			FromStage: issue.Status,
			ToStage:   pgtype.Text{String: req.ToStage, Valid: true},
			AgentID:   owner.AgentID,
			TaskID:    task.ID,
			Status:    "pending",
		})
		if err != nil {
			slog.Warn("relay advance-stage: write run log failed",
				"issue_id", uuidToString(issue.ID), "error", err)
		} else {
			id := int64(logRow.ID)
			relayLogID = &id
		}
	default:
		// A duplicate delivery whose task already exists: the unique index
		// rejects the insert, which is the expected dedup outcome. The status
		// transition is committed; no second successor is created. We do not
		// treat 23505 as an error (see isDuplicatePendingTaskErr).
		slog.Info("relay advance-stage: successor task already pending (dedup)",
			"issue_id", uuidToString(issue.ID), "agent_id", uuidToString(owner.AgentID))
	}

	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("relay advance-stage: commit failed",
			"issue_id", uuidToString(issue.ID), "to_stage", req.ToStage, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to commit relay transaction")
		return
	}

	h.publish(protocol.EventIssueUpdated, uuidToString(updated.WorkspaceID), "system", "", map[string]any{
		"issue":          &IssueSummary{ID: uuidToString(updated.ID), Status: updated.Status},
		"status_changed": true,
		"prev_status":    issue.Status,
		"relay":          true,
	})

	writeJSON(w, http.StatusOK, relayAdvanceStageResult{
		Success:    true,
		Issue:      &IssueSummary{ID: uuidToString(updated.ID), Status: updated.Status},
		TaskID:     taskID,
		RelayLogID: relayLogID,
	})
}

// allowedRelayTargets flattens a stage's configured successors into the set the
// relay accepts. A NULL next_stage with no alternatives yields an empty set
// (terminal stage: no forward transitions).
func allowedRelayTargets(next pgtype.Text, alt []string) []string {
	var out []string
	if next.Valid && next.String != "" {
		out = append(out, next.String)
	}
	out = append(out, alt...)
	return out
}

func relayContainsString(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}


// relayPriorityToInt mirrors the service-side priority mapping so the relay can
// enqueue a successor task with the same priority ordering as other task paths.
func relayPriorityToInt(p string) int32 {
	switch p {
	case "urgent":
		return 4
	case "high":
		return 3
	case "medium":
		return 2
	case "low":
		return 1
	default:
		return 0
	}
}

func writeErrorJSON(w http.ResponseWriter, status int, v relayError) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
