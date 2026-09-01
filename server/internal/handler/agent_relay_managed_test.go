package handler

import (
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestTaskToResponseClassifiesRelayManagedFromPersistedProvenance(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name string
		task db.AgentTaskQueue
		want bool
	}{
		{name: "relay transition provenance", task: db.AgentTaskQueue{TriggerEvidenceKind: pgtype.Text{String: "relay_stage_transition", Valid: true}}, want: true},
		{name: "relay disposition provenance", task: db.AgentTaskQueue{TriggerEvidenceKind: pgtype.Text{String: "relay_disposition", Valid: true}}, want: true},
		{name: "legacy relay requeue envelope", task: db.AgentTaskQueue{Context: []byte(`{"source":"relay-requeue","to_stage":"In Review"}`)}, want: true},
		{name: "comment cannot grant relay ownership", task: db.AgentTaskQueue{TriggerEvidenceKind: pgtype.Text{String: "comment", Valid: true}, Context: []byte(`{"source":"manual-comment"}`)}},
		{name: "malformed context", task: db.AgentTaskQueue{Context: []byte(`{`)}},
		{name: "missing context"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := taskToResponse(tc.task, "workspace-1").RelayManaged
			if got != tc.want {
				t.Fatalf("RelayManaged = %v, want %v", got, tc.want)
			}
		})
	}
}
