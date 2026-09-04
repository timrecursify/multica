package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"

	"github.com/jackc/pgx/v5/pgtype"
)

// RelayReconcileRequest scopes reconciliation to one workspace. The operation
// is intentionally explicit so an operator cannot accidentally scan every board.
type RelayReconcileRequest struct {
	WorkspaceID string `json:"workspace_id"`
}

type relayReconcileResult struct {
	Scanned   int `json:"scanned"`
	Recovered int `json:"recovered"`
	Rejected  int `json:"rejected"`
	Failed    int `json:"failed"`
}

// RelayReconcileStale finds relay issues unchanged for 60 minutes and retries
// the legal Done edge through RelayAdvanceStage. Repeated runs are safe because
// the advance handler locks the issue and deduplicates its successor task.
func (h *Handler) RelayReconcileStale(w http.ResponseWriter, r *http.Request) {
	var req RelayReconcileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.WorkspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspace_id is required")
		return
	}
	ws, ok := parseUUIDOrBadRequest(w, req.WorkspaceID, "workspace_id")
	if !ok {
		return
	}
	rows, err := h.DB.Query(r.Context(), `SELECT i.id FROM issue i WHERE i.workspace_id=$1 AND i.status IN ('In Review','CI/CD & Deploy') AND i.updated_at < now() - interval '60 minutes' AND NOT EXISTS (SELECT 1 FROM relay_run_log l WHERE l.issue_id=i.id AND l.status='completed')`, ws)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to scan stale relays")
		return
	}
	defer rows.Close()
	result := relayReconcileResult{}
	for rows.Next() {
		var id pgtype.UUID
		if err := rows.Scan(&id); err != nil {
			result.Failed++
			continue
		}
		result.Scanned++
		body, _ := json.Marshal(RelayAdvanceStageRequest{IssueID: uuidToString(id), ToStage: "Done"})
		rec := &bufferResponseWriter{header: make(http.Header)}
		req2 := r.Clone(r.Context())
		req2.Body = ioNopCloser{Reader: bytes.NewReader(body)}
		h.RelayAdvanceStage(rec, req2)
		if rec.status >= 200 && rec.status < 300 {
			result.Recovered++
		} else if rec.status == http.StatusConflict || rec.status == http.StatusBadRequest {
			result.Rejected++
			_ = h.recordRelayReconcileFailure(r.Context(), id, rec.statusText())
		} else {
			result.Failed++
		}
	}
	if err := rows.Err(); err != nil {
		result.Failed++
	}
	writeJSON(w, http.StatusOK, result)
}

func (h *Handler) recordRelayReconcileFailure(ctx context.Context, id pgtype.UUID, reason string) error {
	_, err := h.DB.Exec(ctx, `INSERT INTO relay_run_log(issue_id,from_stage,to_stage,status,reason) SELECT id,status,'Done','failed',$2 FROM issue WHERE id=$1`, id, reason)
	return err
}

// tiny response writer and ReadCloser keep reconciliation on the same atomic path.
type bufferResponseWriter struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (w *bufferResponseWriter) Header() http.Header { return w.header }
func (w *bufferResponseWriter) WriteHeader(s int)   { w.status = s }
func (w *bufferResponseWriter) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.status = 200
	}
	return w.body.Write(p)
}
func (w *bufferResponseWriter) statusText() string { return w.body.String() }

type ioNopCloser struct{ *bytes.Reader }

func (ioNopCloser) Close() error { return nil }
