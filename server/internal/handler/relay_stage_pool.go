package handler

import (
	"encoding/json"
	"net/http"

	"github.com/jackc/pgx/v5/pgtype"
)

// ListRelayStagePools exposes the product-owned relay routing contract.  It is
// deliberately workspace-scoped: callers never need (or get) a global view of
// another workspace's agents or configured capacity.
func (h *Handler) ListRelayStagePools(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	rows, err := h.DB.Query(r.Context(), `
SELECT p.id, p.stage_name, p.enabled,
       COALESCE(jsonb_agg(jsonb_build_object(
         'agent_id', a.id, 'enabled', m.enabled,
         'eligible', m.enabled AND a.archived_at IS NULL AND a.workspace_id = p.workspace_id,
         'max_concurrent_tasks', a.max_concurrent_tasks,
         'active_tasks', COALESCE(q.active_tasks, 0),
         'capacity', GREATEST(a.max_concurrent_tasks - COALESCE(q.active_tasks, 0), 0)
       ) ORDER BY a.name) FILTER (WHERE m.agent_id IS NOT NULL), '[]'::jsonb) AS members,
       (SELECT r.agent_id FROM relay_stage_config r WHERE r.stage_name = p.stage_name LIMIT 1) AS legacy_agent_id
FROM relay_stage_pool p
LEFT JOIN relay_stage_agent_pool m ON m.pool_id = p.id
LEFT JOIN agent a ON a.id = m.agent_id
LEFT JOIN LATERAL (SELECT count(*)::int AS active_tasks FROM agent_task_queue t
  WHERE t.agent_id = a.id AND t.status IN ('pending', 'running')) q ON true
WHERE p.workspace_id = $1
GROUP BY p.id, p.stage_name, p.enabled, p.workspace_id
ORDER BY p.stage_name`, workspaceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list relay stage pools")
		return
	}
	defer rows.Close()
	items := make([]map[string]any, 0)
	for rows.Next() {
		var id, legacy pgtype.UUID
		var stage string
		var enabled bool
		var members []byte
		if err := rows.Scan(&id, &stage, &enabled, &members, &legacy); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to read relay stage pools")
			return
		}
		if len(members) == 0 {
			members = []byte("[]")
		}
		item := map[string]any{"id": uuidToString(id), "stage": stage, "enabled": enabled, "members": json.RawMessage(members)}
		if legacy.Valid {
			item["legacy_agent_id"] = uuidToString(legacy)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list relay stage pools")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"pools": items, "total": len(items)})
}
