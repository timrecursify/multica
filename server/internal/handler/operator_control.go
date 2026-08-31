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

// operatorRelayStage is the read-only relay configuration view.
type operatorRelayStage struct {
	ID            int32    `json:"id"`
	StageName     string   `json:"stage_name"`
	NextStage     *string  `json:"next_stage"`
	AgentID       *string  `json:"agent_id"`
	AgentName     *string  `json:"agent_name"`
	AltNextStages []string `json:"alt_next_stages,omitempty"`
}

func operatorRelayStageOf(r db.RelayStageConfig) operatorRelayStage {
	return operatorRelayStage{
		ID:            r.ID,
		StageName:     r.StageName,
		NextStage:     textToPtr(r.NextStage),
		AgentID:       uuidToPtr(r.AgentID),
		AgentName:     textToPtr(r.AgentName),
		AltNextStages: r.AltNextStages,
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

	updated := target
	apply := func(params db.UpdateAgentParams) {
		params.ID = target.ID
		updated, err = h.Queries.UpdateAgent(r.Context(), params)
	}
	if req.MaxConcurrentTasks != nil {
		if err := validateAgentMaxConcurrentTasks(*req.MaxConcurrentTasks); err != nil {
			writeErrorCode(w, http.StatusBadRequest, "invalid_input", err.Error())
			return
		}
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
			updated, err = h.Queries.ClearAgentThinkingLevel(r.Context(), target.ID)
		} else {
			provider, ok := h.resolveAgentProvider(r, workspaceID, target.RuntimeID)
			if !ok {
				writeError(w, http.StatusInternalServerError, "failed to resolve runtime provider")
				return
			}
			if !agent.IsKnownThinkingValue(provider, *req.ThinkingLevel) {
				writeErrorCode(w, http.StatusBadRequest, "invalid_input",
					"thinking_level "+*req.ThinkingLevel+" is not recognised for runtime provider "+provider)
				return
			}
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
			updated, err = h.Queries.ClearAgentServiceTier(r.Context(), target.ID)
		} else {
			provider, ok := h.resolveAgentProvider(r, workspaceID, target.RuntimeID)
			if !ok {
				writeError(w, http.StatusInternalServerError, "failed to resolve runtime provider")
				return
			}
			if !agent.IsKnownServiceTier(provider, *req.ServiceTier) {
				writeErrorCode(w, http.StatusBadRequest, "invalid_input",
					"service_tier "+*req.ServiceTier+" is not recognised for runtime provider "+provider)
				return
			}
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
			updated, err = h.Queries.ArchiveAgent(r.Context(), db.ArchiveAgentParams{ID: target.ID, ArchivedBy: target.OwnerID})
			if err != nil {
				writeError(w, http.StatusInternalServerError, "failed to archive agent")
				return
			}
		} else if !*req.Archived && updated.ArchivedAt.Valid {
			updated, err = h.Queries.RestoreAgent(r.Context(), target.ID)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "failed to restore agent")
				return
			}
		}
	}

	writeJSON(w, http.StatusOK, operatorAgentViewOf(updated))
}

// ListWorkspaceRelayStages lists the configured relay stages.
func (h *Handler) ListWorkspaceRelayStages(w http.ResponseWriter, r *http.Request) {
	if _, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "workspaceId"), "workspace_id"); !ok { return }
	rows, err := h.Queries.ListRelayStageConfig(r.Context())
	if err != nil {
		slog.Warn("operator relay list failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to list relay stages")
		return
	}
	out := make([]operatorRelayStage, 0, len(rows))
	for _, row := range rows {
		out = append(out, operatorRelayStageOf(row))
	}
	writeJSON(w, http.StatusOK, map[string]any{"stages": out, "count": len(out)})
}

// GetWorkspaceRelayStage returns one exact relay stage by name.
func (h *Handler) GetWorkspaceRelayStage(w http.ResponseWriter, r *http.Request) {
	if _, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "workspaceId"), "workspace_id"); !ok { return }
	row, err := h.Queries.GetRelayStageConfig(r.Context(), chi.URLParam(r, "stageName"))
	if err == pgx.ErrNoRows {
		writeErrorCode(w, http.StatusNotFound, "stage_not_found", "no such relay stage")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read relay stage")
		return
	}
	writeJSON(w, http.StatusOK, operatorRelayStageOf(row))
}

// operatorRelayOwnerRequest sets or clears the owner (agent) for one exact
// relay stage transition. agent_id may be null/empty to clear ownership.
type operatorRelayOwnerRequest struct {
	AgentID *string `json:"agent_id"`
	SuccessorStage string `json:"successor_stage,omitempty"`
}

// SetWorkspaceRelayStageOwner atomically sets (or clears) the relay stage
// owner for the named stage. The agent must resolve to a member of the same
// workspace; cross-workspace agent ids are refused.
func (h *Handler) SetWorkspaceRelayStageOwner(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "workspaceId"), "workspace_id")
	if !ok {
		return
	}
	target, err := h.Queries.GetRelayStageConfig(r.Context(), chi.URLParam(r, "stageName"))
	if err == pgx.ErrNoRows {
		writeErrorCode(w, http.StatusNotFound, "stage_not_found", "no such relay stage")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read relay stage")
		return
	}

	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var req operatorRelayOwnerRequest
	if err := decoder.Decode(&req); err != nil {
		writeErrorCode(w, http.StatusBadRequest, "invalid_input", "invalid request body: "+err.Error())
		return
	}
	if req.SuccessorStage != "" {
		valid := target.NextStage.Valid && target.NextStage.String == req.SuccessorStage
		if !valid { for _, s := range target.AltNextStages { if s == req.SuccessorStage { valid = true; break } } }
		if !valid { writeErrorCode(w, http.StatusBadRequest, "invalid_input", "successor_stage is not configured for this source stage"); return }
	}

	agentName := ""
	agentUUID := pgtype.UUID{}
	if req.AgentID != nil && *req.AgentID != "" {
		parsed, ok := parseUUIDOrBadRequest(w, *req.AgentID, "agent_id")
		if !ok {
			return
		}
		ownerAgent, err := h.Queries.GetAgentInWorkspace(r.Context(), db.GetAgentInWorkspaceParams{
			ID:          parsed,
			WorkspaceID: workspaceID,
		})
		if err != nil {
			writeErrorCode(w, http.StatusBadRequest, "invalid_input", "agent_id is not a user agent in this workspace")
			return
		}
		agentUUID = ownerAgent.ID
		agentName = ownerAgent.Name
	}

	updated, err := h.Queries.SetRelayStageOwner(r.Context(), db.SetRelayStageOwnerParams{
		StageName: target.StageName,
		AgentID:   agentUUID,
		AgentName: pgtype.Text{String: agentName, Valid: agentName != ""},
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update relay stage owner")
		return
	}

	slog.Info("operator relay owner set",
		"stage", target.StageName,
		"workspace_id", uuidToString(workspaceID),
		"agent_id", uuidToString(agentUUID),
	)
	writeJSON(w, http.StatusOK, operatorRelayStageOf(updated))
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
