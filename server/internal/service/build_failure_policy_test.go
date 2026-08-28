package service

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/pkg/taskfailure"
)

func TestBuildFailurePolicy(t *testing.T) {
	tests := []struct {
		name      string
		reason    string
		attempt   int32
		progress  bool
		wantClass buildFailureClass
		wantState string
		wantTerm  string
		wantInc   bool
		wantRetry buildRetryKind
		wantHuman bool
	}{
		{"402 quota parks", string(taskfailure.ReasonAgentProviderQuotaLimit), 1, false, buildFailureInfra, "parked", "blocked_provider", false, buildRetryNone, false},
		{"429 capacity parks", string(taskfailure.ReasonAgentProviderCapacityOrRateLimit), 1, false, buildFailureInfra, "parked", "blocked_provider", false, buildRetryNone, false},
		{"network parks", string(taskfailure.ReasonAgentProviderNetwork), 1, false, buildFailureInfra, "parked", "blocked_provider", false, buildRetryNone, false},
		{"auth parks", string(taskfailure.ReasonAgentProviderAuthOrAccess), 1, false, buildFailureInfra, "parked", "blocked_provider", false, buildRetryNone, false},
		{"runtime executable missing parks", string(taskfailure.ReasonAgentRuntimeMissingExecutable), 1, false, buildFailureInfra, "parked", "blocked_provider", false, buildRetryNone, false},
		{"runtime version unsupported parks", string(taskfailure.ReasonAgentRuntimeVersionUnsupported), 1, false, buildFailureInfra, "parked", "blocked_provider", false, buildRetryNone, false},
		{"missing spec human review", "missing_spec", 1, false, buildFailureSpec, "parked", "blocked_spec", false, buildRetryNone, true},
		{"missing dependency human review", "missing_dependency", 1, false, buildFailureSpec, "parked", "blocked_spec", false, buildRetryNone, true},
		{"spec dispute human review", "spec_dispute", 1, false, buildFailureSpec, "parked", "blocked_spec", false, buildRetryNone, true},
		{"first useful defect fresh retry", string(taskfailure.ReasonAgentProcessFailure), 1, true, buildFailureDefect, "failed", "defect", true, buildRetryFresh, false},
		{"second useful defect stronger runtime", string(taskfailure.ReasonAgentProcessFailure), 2, true, buildFailureDefect, "failed", "defect", true, buildRetryStronger, false},
		{"third useful defect stops", string(taskfailure.ReasonAgentProcessFailure), 3, true, buildFailureDefect, "failed", "defect", true, buildRetryNone, false},
		{"defect without progress stops", string(taskfailure.ReasonAgentProcessFailure), 1, false, buildFailureDefect, "failed", "defect", true, buildRetryNone, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := decideBuildFailure(tt.reason, tt.attempt, tt.progress)
			if got.Class != tt.wantClass || got.RunState != tt.wantState || got.TerminalReason != tt.wantTerm ||
				got.IncrementAttempts != tt.wantInc || got.Retry != tt.wantRetry || got.HumanReview != tt.wantHuman {
				t.Fatalf("decision = %+v", got)
			}
		})
	}
}

func TestClaimTaskRefusesMissingAgentIdentityBeforeDatabaseAccess(t *testing.T) {
	svc := &TaskService{}
	task, err := svc.ClaimTask(context.Background(), pgtype.UUID{})
	if task != nil {
		t.Fatalf("task = %+v, want nil", task)
	}
	if err == nil || !strings.Contains(err.Error(), "registered agent identity is required") {
		t.Fatalf("error = %v, want registered-identity refusal", err)
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
