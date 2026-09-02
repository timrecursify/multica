package handler

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/util"
	"github.com/multica-ai/multica/server/pkg/agent"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// GSP-806: workspace-scoped operator surface for the agent roster and the
// relay-stage ownership/configuration. These endpoints sit beside the
// PPP-21291 operator repair API (same MULTICA_OPERATOR_SECRET bearer) and are
// routed to the selected board's own backend, so --board routing enforces the
// workspace boundary. They deliberately expose ONLY the mutable fields the
// reports require; env and mcp_config secrets are never serialized here.

// operatorAgentView is the read-mostly roster view. Only the fields a desk
// operator may act on are surfaced; custom_env / mcp_config / runtime_config
// gateway tokens are omitted entirely.
type operatorAgentView struct {
	ID                 string  `json:"id"`
	WorkspaceID        string  `json:"workspace_id"`
	Name               string  `json:"name"`
	Status             string  `json:"status"`
	MaxConcurrentTasks int32   `json:"max_concurrent_tasks"`
	Model              *string `json:"model"`
	ThinkingLevel      *string `json:"thinking_level"`
	ServiceTier        *string `json:"service_tier"`
	RuntimeID          *string `json:"runtime_id"`
	CreatedAt          string  `json:"created_at"`
	UpdatedAt          string  `json:"updated_at"`
	ArchivedAt         *string `json:"archived_at"`
	ArchivedBy         *string `json:"archived_by"`
}

func operatorAgentViewOf(a db.Agent) operatorAgentView {
	return operatorAgentView{
		ID:                 uuidToString(a.ID),
		WorkspaceID:        uuidToString(a.WorkspaceID),
		Name:               a.Name,
		Status:             a.Status,
		MaxConcurrentTasks: a.MaxConcurrentTasks,
		Model:              textToPtr(a.Model),
		ThinkingLevel:      textToPtr(a.ThinkingLevel),
		ServiceTier:        textToPtr(a.ServiceTier),
		RuntimeID:          uuidToPtr(a.RuntimeID),
		CreatedAt:          timestampToString(a.CreatedAt),
		UpdatedAt:          timestampToString(a.UpdatedAt),
		ArchivedAt:         timestampToPtr(a.ArchivedAt),
		ArchivedBy:         uuidToPtr(a.ArchivedBy),
	}
}

// ListWorkspaceOperatorAgents lists every user agent in the workspace,
// including archived rows (an operator must see archived state to restore it).
func (h *Handler) ListWorkspaceOperatorAgents(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "workspaceId"), "workspace_id")
	if !ok {
		return
	}
	agents, err := h.Queries.ListAllAgents(r.Context(), workspaceID)
	if err != nil {
		slog.Warn("operator agent list failed", "workspace_id", uuidToString(workspaceID), "error", err)
		writeError(w, http.StatusInternalServerError, "failed to list agents")
		return
	}
	out := make([]operatorAgentView, 0, len(agents))
	for _, a := range agents {
		out = append(out, operatorAgentViewOf(a))
	}
	writeJSON(w, http.StatusOK, map[string]any{"agents": out, "count": len(out)})
}

// GetWorkspaceOperatorAgent resolves one agent by UUID or exact name within
// the workspace and returns its operator view.
func (h *Handler) GetWorkspaceOperatorAgent(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "workspaceId"), "workspace_id")
	if !ok {
		return
	}
	agent, err := h.lookupOperatorAgent(r, workspaceID, chi.URLParam(r, "ref"))
	if err == pgx.ErrNoRows {
		writeErrorCode(w, http.StatusNotFound, "agent_not_found", "no agent matches the reference in this workspace")
		return
	}
	if err != nil {
		slog.Warn("operator agent get failed", "workspace_id", uuidToString(workspaceID), "error", err)
		writeError(w, http.StatusInternalServerError, "failed to resolve agent")
		return
	}
	writeJSON(w, http.StatusOK, operatorAgentViewOf(agent))
}

// operatorAgentUpdateRequest carries ONLY the bounded mutable roster fields.
// Unknown fields are rejected via DisallowUnknownFields in the handler.
type operatorAgentUpdateRequest struct {
	MaxConcurrentTasks *int32  `json:"max_concurrent_tasks"`
	Model              *string `json:"model"`
	ThinkingLevel      *string `json:"thinking_level"`
	ServiceTier        *string `json:"service_tier"`
	Archived           *bool   `json:"archived"`
}

// UpdateWorkspaceOperatorAgent applies a bounded update to one agent in the
// workspace. `archived=true` archives (idempotent if already archived);
// `archived=false` restores. Other fields are validated before mutation.
func (h *Handler) UpdateWorkspaceOperatorAgent(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "workspaceId"), "workspace_id")
	if !ok {
		return
	}
	target, err := h.lookupOperatorAgent(r, workspaceID, chi.URLParam(r, "ref"))
	if err == pgx.ErrNoRows {
		writeErrorCode(w, http.StatusNotFound, "agent_not_found", "no agent matches the reference in this workspace")
		return
	}
	if err != nil {
		slog.Warn("operator agent update lookup failed", "workspace_id", uuidToString(workspaceID), "error", err)
		writeError(w, http.StatusInternalServerError, "failed to resolve agent")
		return
	}

	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var req operatorAgentUpdateRequest
	if err := decoder.Decode(&req); err != nil {
		writeErrorCode(w, http.StatusBadRequest, "invalid_input", "invalid request body: "+err.Error())
		return
	}
	// Validate the complete request before opening a write transaction. This
	// prevents a valid early field from being persisted when a later field is
	// malformed or unsupported.
	if req.MaxConcurrentTasks != nil {
		if err := validateAgentMaxConcurrentTasks(*req.MaxConcurrentTasks); err != nil {
			writeErrorCode(w, http.StatusBadRequest, "invalid_input", err.Error())
			return
		}
	}
	provider := ""
	if req.ThinkingLevel != nil && *req.ThinkingLevel != "" || req.ServiceTier != nil && *req.ServiceTier != "" {
		var providerOK bool
		provider, providerOK = h.resolveAgentProvider(r, workspaceID, target.RuntimeID)
		if !providerOK {
			writeError(w, http.StatusInternalServerError, "failed to resolve runtime provider")
			return
		}
	}
	if req.ThinkingLevel != nil && *req.ThinkingLevel != "" && !agent.IsKnownThinkingValue(provider, *req.ThinkingLevel) {
		writeErrorCode(w, http.StatusBadRequest, "invalid_input",
			"thinking_level "+*req.ThinkingLevel+" is not recognised for runtime provider "+provider)
		return
	}
	if req.ServiceTier != nil && *req.ServiceTier != "" && !agent.IsKnownServiceTier(provider, *req.ServiceTier) {
		writeErrorCode(w, http.StatusBadRequest, "invalid_input",
			"service_tier "+*req.ServiceTier+" is not recognised for runtime provider "+provider)
		return
	}
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start agent update")
		return
	}
	defer tx.Rollback(r.Context())
	queries := h.Queries.WithTx(tx)

	updated := target
	apply := func(params db.UpdateAgentParams) {
		params.ID = target.ID
		updated, err = queries.UpdateAgent(r.Context(), params)
	}
	if req.MaxConcurrentTasks != nil {
		params := db.UpdateAgentParams{ID: target.ID}
		params.MaxConcurrentTasks = pgtype.Int4{Int32: *req.MaxConcurrentTasks, Valid: true}
		apply(params)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to update agent")
			return
		}
	}
	if req.Model != nil {
		params := db.UpdateAgentParams{ID: target.ID}
		params.Model = pgtype.Text{String: *req.Model, Valid: true}
		apply(params)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to update agent")
			return
		}
	}
	if req.ThinkingLevel != nil {
		if *req.ThinkingLevel == "" {
			updated, err = queries.ClearAgentThinkingLevel(r.Context(), target.ID)
		} else {
			params := db.UpdateAgentParams{ID: target.ID}
			params.ThinkingLevel = pgtype.Text{String: *req.ThinkingLevel, Valid: true}
			apply(params)
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to update agent")
			return
		}
	}
	if req.ServiceTier != nil {
		if *req.ServiceTier == "" {
			updated, err = queries.ClearAgentServiceTier(r.Context(), target.ID)
		} else {
			params := db.UpdateAgentParams{ID: target.ID}
			params.ServiceTier = pgtype.Text{String: *req.ServiceTier, Valid: true}
			apply(params)
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to update agent")
			return
		}
	}
	if req.Archived != nil {
		if *req.Archived && !updated.ArchivedAt.Valid {
			updated, err = queries.ArchiveAgent(r.Context(), db.ArchiveAgentParams{ID: target.ID, ArchivedBy: target.OwnerID})
			if err != nil {
				writeError(w, http.StatusInternalServerError, "failed to archive agent")
				return
			}
		} else if !*req.Archived && updated.ArchivedAt.Valid {
			updated, err = queries.RestoreAgent(r.Context(), target.ID)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "failed to restore agent")
				return
			}
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit agent update")
		return
	}

	writeJSON(w, http.StatusOK, operatorAgentViewOf(updated))
}

// lookupOperatorAgent resolves an agent by UUID or exact name inside the
// workspace. Returns pgx.ErrNoRows when nothing matches.
func (h *Handler) lookupOperatorAgent(r *http.Request, workspaceID pgtype.UUID, ref string) (db.Agent, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return db.Agent{}, pgx.ErrNoRows
	}
	if uid, err := util.ParseUUID(ref); err == nil {
		a, err := h.Queries.GetAgentInWorkspace(r.Context(), db.GetAgentInWorkspaceParams{ID: uid, WorkspaceID: workspaceID})
		if err == nil {
			return a, nil
		}
		if errors.Is(err, pgx.ErrNoRows) {
			return db.Agent{}, pgx.ErrNoRows
		}
		return db.Agent{}, err
	}
	return h.Queries.GetAgentInWorkspaceByName(r.Context(), db.GetAgentInWorkspaceByNameParams{Name: ref, WorkspaceID: workspaceID})
}
