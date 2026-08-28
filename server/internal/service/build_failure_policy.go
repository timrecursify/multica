package service

import "github.com/multica-ai/multica/server/pkg/taskfailure"

type buildFailureClass string

const (
	buildFailureInfra  buildFailureClass = "infrastructure"
	buildFailureDefect buildFailureClass = "defect"
	buildFailureSpec   buildFailureClass = "spec"
)

type buildRetryKind string

const (
	buildRetryNone     buildRetryKind = ""
	buildRetryFresh    buildRetryKind = "fresh"
	buildRetryStronger buildRetryKind = "stronger_runtime"
)

type buildFailureDecision struct {
	Class             buildFailureClass
	RunState          string
	TerminalReason    string
	IncrementAttempts bool
	Retry             buildRetryKind
	HumanReview       bool
}

const buildDefectMaxAttempts int32 = 3

// decideBuildFailure is the executable WP-4 escalation table. Provider-side
// failures park without charging the ticket, missing-input failures go to human
// review without a model retry, and implementation defects with useful progress
// get one clean retry followed by one explicit stronger-runtime escalation.
func decideBuildFailure(reason string, attempt int32, usefulProgress bool) buildFailureDecision {
	switch reason {
	case string(taskfailure.ReasonAgentProviderAuthOrAccess),
		string(taskfailure.ReasonAgentProviderQuotaLimit),
		string(taskfailure.ReasonAgentProviderCapacityOrRateLimit),
		string(taskfailure.ReasonAgentProviderServerError),
		string(taskfailure.ReasonAgentProviderNetwork),
		string(taskfailure.ReasonAgentMissingConfig),
		string(taskfailure.ReasonAgentModelNotFoundOrUnavailable),
		string(taskfailure.ReasonAgentRuntimeMissingExecutable),
		string(taskfailure.ReasonAgentRuntimeVersionUnsupported):
		return buildFailureDecision{
			Class:          buildFailureInfra,
			RunState:       "parked",
			TerminalReason: "blocked_provider",
		}
	case "missing_spec", "missing_dependency", "spec_dispute", "agent_blocked":
		return buildFailureDecision{
			Class:          buildFailureSpec,
			RunState:       "parked",
			TerminalReason: "blocked_spec",
			HumanReview:    true,
		}
	default:
		decision := buildFailureDecision{
			Class:             buildFailureDefect,
			RunState:          "failed",
			TerminalReason:    "defect",
			IncrementAttempts: true,
		}
		if usefulProgress && attempt < buildDefectMaxAttempts {
			switch attempt {
			case 1:
				decision.Retry = buildRetryFresh
			case 2:
				decision.Retry = buildRetryStronger
			}
		}
		return decision
	}
}

func issueStatusForExistingPR(openCount, mergedCount int64) (string, bool) {
	if openCount > 0 {
		return "in_review", true
	}
	if mergedCount > 0 {
		return "done", true
	}
	return "", false
}
