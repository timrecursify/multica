package handler

import (
	"encoding/json"
	"net/http"
	"sort"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/util"
)

// relayStagePoolRequest intentionally replaces the complete member set.  This
// makes enabled/non-empty validation atomic and avoids a transient empty pool
// during an operator expansion.
type relayStagePoolRequest struct {
	Enabled bool     `json:"enabled"`
	Members []string `json:"members"`
}

type diagnosisOwnershipReadback struct {
	Mode        string `json:"mode"`
	Explanation string `json:"explanation"`
}

func stagePoolDiagnosisOwnership(stage string) *diagnosisOwnershipReadback {
	if stage != "Parked" {
		return nil
	}
	return &diagnosisOwnershipReadback{
		Mode:        "dedicated_workspace_diagnosis_seats",
		Explanation: "Parked diagnosis reruns select dedicated workspace diagnosis seats independently of this configured build pool.",
	}
}

// ListRelayStagePools is the authenticated operator readback.  It reports a
// dangling legacy binding rather than silently selecting an arbitrary member.
func (h *Handler) ListRelayStagePools(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	if _, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found"); !ok {
		return
	}
	rows, err := h.DB.Query(r.Context(), `
SELECT p.stage_name, p.enabled, p.legacy_agent_id::text,
       legacy.name, legacy.archived_at IS NULL,
       COALESCE(json_agg(json_build_object('id', m.agent_id::text, 'name', a.name, 'status', a.status)
         ORDER BY a.name) FILTER (WHERE m.agent_id IS NOT NULL), '[]'::json)
  FROM relay_stage_pool p
  LEFT JOIN agent legacy ON legacy.id = p.legacy_agent_id AND legacy.workspace_id = p.workspace_id
  LEFT JOIN relay_stage_agent_pool m ON m.workspace_id = p.workspace_id AND m.stage_name = p.stage_name AND m.enabled
  LEFT JOIN agent a ON a.id = m.agent_id AND a.workspace_id = m.workspace_id AND a.archived_at IS NULL
 WHERE p.workspace_id = $1::uuid
 GROUP BY p.stage_name, p.enabled, p.legacy_agent_id, legacy.name, legacy.archived_at
 ORDER BY p.stage_name`, workspaceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read relay stage pools")
		return
	}
	defer rows.Close()
	type response struct {
		Stage              string                      `json:"stage"`
		Enabled            bool                        `json:"enabled"`
		LegacyAgentID      *string                     `json:"legacy_agent_id,omitempty"`
		LegacyAgentName    *string                     `json:"legacy_agent_name,omitempty"`
		LegacyDangling     bool                        `json:"legacy_dangling"`
		Members            json.RawMessage             `json:"members"`
		DiagnosisOwnership *diagnosisOwnershipReadback `json:"diagnosis_ownership,omitempty"`
	}
	result := []response{}
	for rows.Next() {
		var item response
		var legacyID, legacyName *string
		var live *bool
		if err := rows.Scan(&item.Stage, &item.Enabled, &legacyID, &legacyName, &live, &item.Members); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to read relay stage pools")
			return
		}
		item.LegacyAgentID, item.LegacyAgentName = legacyID, legacyName
		item.LegacyDangling = legacyID != nil && (legacyName == nil || live == nil || !*live)
		item.DiagnosisOwnership = stagePoolDiagnosisOwnership(item.Stage)
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read relay stage pools")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"pools": result})
}

// ReplaceRelayStagePool validates every member in the same transaction before
// making the enabled pool visible to relay selection.
func (h *Handler) ReplaceRelayStagePool(w http.ResponseWriter, r *http.Request) {
	workspaceID, stage := h.resolveWorkspaceID(r), chi.URLParam(r, "stage")
	if _, ok := h.requireWorkspaceRole(w, r, workspaceID, "workspace not found", "owner", "admin"); !ok {
		return
	}
	var body relayStagePoolRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if stage == "" {
		writeError(w, http.StatusBadRequest, "stage is required")
		return
	}
	if body.Enabled && len(body.Members) == 0 {
		writeError(w, http.StatusBadRequest, "enabled pool requires at least one member")
		return
	}
	sort.Strings(body.Members)
	for i, id := range body.Members {
		if _, err := util.ParseUUID(id); err != nil || (i > 0 && id == body.Members[i-1]) {
			writeError(w, http.StatusBadRequest, "members must be unique UUIDs")
			return
		}
	}
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start relay pool update")
		return
	}
	defer tx.Rollback(r.Context())
	if _, err = tx.Exec(r.Context(), `INSERT INTO relay_stage_pool (workspace_id, stage_name, enabled) VALUES ($1::uuid,$2,$3) ON CONFLICT (workspace_id,stage_name) DO UPDATE SET enabled=EXCLUDED.enabled,updated_at=now()`, workspaceID, stage, body.Enabled); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save relay pool")
		return
	}
	for _, id := range body.Members {
		var exists bool
		if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM agent WHERE id=$1::uuid AND workspace_id=$2::uuid AND archived_at IS NULL)`, id, workspaceID).Scan(&exists); err != nil || !exists {
			writeError(w, http.StatusBadRequest, "pool member must be a live workspace agent")
			return
		}
	}
	if _, err = tx.Exec(r.Context(), `DELETE FROM relay_stage_agent_pool WHERE workspace_id=$1::uuid AND stage_name=$2`, workspaceID, stage); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to replace relay pool members")
		return
	}
	for _, id := range body.Members {
		if _, err = tx.Exec(r.Context(), `INSERT INTO relay_stage_agent_pool (workspace_id,stage_name,agent_id,enabled) VALUES ($1::uuid,$2,$3::uuid,true)`, workspaceID, stage, id); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to save relay pool member")
			return
		}
	}
	if err = tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit relay pool update")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"stage": stage, "enabled": body.Enabled, "members": body.Members})
}
