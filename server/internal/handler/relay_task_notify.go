package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// RelayTaskEnqueued restores the post-commit notification for a task created
// by the legacy relay bridge. The bridge is deliberately limited to supplying
// a task ID: this server process owns both the empty-claim cache and daemon
// wakeup hub, so notifying through any other TaskService instance would leave
// a stale empty verdict in place.
func (h *Handler) RelayTaskEnqueued(w http.ResponseWriter, r *http.Request) {
	taskID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "taskId"), "task_id")
	if !ok {
		return
	}
	task, err := h.Queries.GetAgentTask(r.Context(), taskID)
	if err != nil {
		writeError(w, http.StatusNotFound, "task not found")
		return
	}
	h.TaskService.NotifyTaskEnqueued(r.Context(), task)
	writeJSON(w, http.StatusOK, map[string]string{"status": "notified"})
}
