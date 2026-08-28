package service

import (
	"testing"

	"github.com/multica-ai/multica/server/pkg/taskfailure"
)

func TestBuildFailurePolicy(t *testing.T) {
	tests := []struct {
		name      string
		reason    string
		attempt   int32
		wantState string
		wantTerm  string
		wantInc   bool
		wantRetry buildRetryKind
		wantHuman bool
	}{
		{"402 quota parks", string(taskfailure.ReasonAgentProviderQuotaLimit), 1, "parked", "blocked_provider", false, buildRetryNone, false},
		{"429 capacity parks", string(taskfailure.ReasonAgentProviderCapacityOrRateLimit), 1, "parked", "blocked_provider", false, buildRetryNone, false},
		{"network parks", string(taskfailure.ReasonAgentProviderNetwork), 1, "parked", "blocked_provider", false, buildRetryNone, false},
		{"auth parks", string(taskfailure.ReasonAgentProviderAuthOrAccess), 1, "parked", "blocked_provider", false, buildRetryNone, false},
		{"missing spec human review", "missing_spec", 1, "parked", "blocked_spec", false, buildRetryNone, true},
		{"first defect fresh retry", string(taskfailure.ReasonAgentProcessFailure), 1, "failed", "defect", true, buildRetryFresh, false},
		{"second defect stronger runtime", string(taskfailure.ReasonAgentProcessFailure), 2, "failed", "defect", true, buildRetryStronger, false},
		{"third defect stops", string(taskfailure.ReasonAgentProcessFailure), 3, "failed", "defect", true, buildRetryNone, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := decideBuildFailure(tt.reason, tt.attempt)
			if got.RunState != tt.wantState || got.TerminalReason != tt.wantTerm ||
				got.IncrementAttempts != tt.wantInc || got.Retry != tt.wantRetry || got.HumanReview != tt.wantHuman {
				t.Fatalf("decision = %+v", got)
			}
		})
	}
}

func TestIssueStatusForExistingPR(t *testing.T) {
	if got, ok := issueStatusForExistingPR(1, 2); !ok || got != "in_review" {
		t.Fatalf("open PR must win over merged siblings, got %q ok=%v", got, ok)
	}
	if got, ok := issueStatusForExistingPR(0, 2); !ok || got != "done" {
		t.Fatalf("merged PR must reconcile done, got %q ok=%v", got, ok)
	}
	if got, ok := issueStatusForExistingPR(0, 0); ok || got != "" {
		t.Fatalf("no PR must admit the model, got %q ok=%v", got, ok)
	}
}
