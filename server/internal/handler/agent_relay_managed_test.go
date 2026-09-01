package handler

import (
	"testing"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestTaskToResponseClassifiesOnlyRelayAdvanceContextAsManaged(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name    string
		context []byte
		want    bool
	}{
		{name: "relay belt task", context: []byte(`{"source":"relay-advance","to_stage":"In Review"}`), want: true},
		{name: "ordinary issue task", context: []byte(`{"head_sha":"0123456789012345678901234567890123456789"}`)},
		{name: "malformed context", context: []byte(`{`)},
		{name: "missing context"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := taskToResponse(db.AgentTaskQueue{Context: tc.context}, "workspace-1").RelayManaged
			if got != tc.want {
				t.Fatalf("RelayManaged = %v, want %v", got, tc.want)
			}
		})
	}
}
