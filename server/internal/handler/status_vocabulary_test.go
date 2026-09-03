package handler

import "testing"

func TestBackendStatusVocabularyPinsBothBackends(t *testing.T) {
	want := []string{"Registered", "Spec", "Queue", "In Progress", "In Review", "Human Review", "CI/CD & Deploy", "Done", "Archived", "Cancelled"}
	for _, profile := range []IssueStatusProfile{IssueStatusProfilePPP, IssueStatusProfileLinear} {
		if len(BackendStatusVocabulary[profile]) != len(want) {
			t.Fatalf("%s vocabulary size = %d, want %d", profile, len(BackendStatusVocabulary[profile]), len(want))
		}
		for _, canonical := range want {
			if token, ok := BackendWireStatus(profile, canonical); !ok || token == "" {
				t.Errorf("%s missing wire token for %q", profile, canonical)
			}
		}
	}
	if token, _ := BackendWireStatus(IssueStatusProfileLinear, "In Progress"); token != "in_progress" {
		t.Errorf("linear In Progress wire token = %q", token)
	}
}
