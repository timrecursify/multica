package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestRequireFencedRunIdentityRejectsMissingAndMismatchedIdentity(t *testing.T) {
	buildRunID := pgtype.UUID{Bytes: [16]byte{1}, Valid: true}
	task := db.AgentTaskQueue{BuildRunID: buildRunID}

	for _, tc := range []struct{ name, runID, fence string }{
		{name: "missing"},
		{name: "mismatched run", runID: "02000000-0000-0000-0000-000000000000", fence: "1"},
		{name: "invalid fence", runID: "01000000-0000-0000-0000-000000000000", fence: "0"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			if identity, ok := requireFencedRunIdentity(w, task, tc.runID, tc.fence); ok || identity != nil {
				t.Fatalf("identity=%v ok=%v, want rejection", identity, ok)
			}
			if w.Code != http.StatusConflict && w.Code != http.StatusBadRequest {
				t.Fatalf("status=%d, want 409 or 400", w.Code)
			}
		})
	}
}
