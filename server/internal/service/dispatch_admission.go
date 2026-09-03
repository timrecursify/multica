package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/dispatch"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// DispatchAdmissionPolicy configures the MINT-5 dispatch/load admission gate.
// A zero value (or a nil Policy field on TaskService) disables the gate entirely
// so every deployment that has not opted in behaves exactly as before. Once a
// policy is configured, enqueue paths snapshot global dispatch load and reject
// or defer new work beyond the configured caps, emitting a near-limit alert
// as load approaches the alert threshold.
type DispatchAdmissionPolicy struct {
	// MaxQueueDepth rejects new enqueues once the global queued-task count
	// reaches this value.
	MaxQueueDepth int
	// MaxConcurrent rejects new enqueues once the global active-task
	// (dispatched + running + waiting_local_directory) count reaches this value.
	MaxConcurrent int
	// AlertThreshold, in [0,1], is the fraction of capacity at/above which the
	// gate defers new work and flags NearLimit so Ops can alert before overload.
	// 0 disables the defer band and the alert.
	AlertThreshold float64
	// BackoffBase is the starting exponential backoff for deferred enqueues.
	BackoffBase time.Duration
	// BackoffCap is the maximum backoff a deferred enqueue may reach.
	BackoffCap time.Duration
}

func (p *DispatchAdmissionPolicy) policy() dispatch.AdmissionPolicy {
	if p == nil {
		return dispatch.AdmissionPolicy{}
	}
	return dispatch.AdmissionPolicy{
		MaxQueueDepth:  p.MaxQueueDepth,
		MaxConcurrent:  p.MaxConcurrent,
		AlertThreshold: p.AlertThreshold,
		BackoffBase:    p.BackoffBase,
		BackoffCap:     p.BackoffCap,
	}
}

// ErrDispatchOverloaded marks an enqueue refused by the admission gate at the
// hard cap. Callers that surface it as a transient 429-style response should
// NOT let a rejected task fall into an immediate retry loop.
var ErrDispatchOverloaded = errors.New("dispatch admission gate: capacity exceeded, task rejected")

// snapshotDispatchLoad reads the global dispatch load snapshot used by the gate.
func (s *TaskService) snapshotDispatchLoad(ctx context.Context) (dispatch.Load, error) {
	if s == nil || s.Queries == nil {
		return dispatch.Load{}, nil
	}
	row, err := s.Queries.SnapshotDispatchLoad(ctx)
	if err != nil {
		return dispatch.Load{}, fmt.Errorf("snapshot dispatch load: %w", err)
	}
	return dispatch.Load{
		QueueDepth:       int(row.QueuedDepth),
		ActiveConcurrent: int(row.ActiveConcurrent),
	}, nil
}

// admitWithGate is a sentinel error describing a deferred enqueue. The caller
// reads RetryAfterSeconds for the backoff.
type dispatchDeferredError struct {
	retryAfter time.Duration
}

func (e *dispatchDeferredError) Error() string {
	return fmt.Sprintf("dispatch admission gate: load near limit, retry after %s", e.retryAfter)
}

// ErrDispatchDeferred is the typed outcome for a gated enqueue held for
// retry. Callers can unwrap it to read the backoff duration.
var ErrDispatchDeferred = &dispatchDeferredError{}

// admitWithGate runs the configured admission gate against the current global
// dispatch load for the given class and acts on the decision. It returns nil
// when the task may proceed. On a hard reject it returns ErrDispatchOverloaded;
// on a near-limit defer it returns a *dispatchDeferredError carrying the
// exponential RetryAfter. Nil or zero policy admits everything.
func (s *TaskService) admitWithGate(ctx context.Context, class dispatch.AdmissionClass) error {
	if s == nil {
		return nil
	}
	return s.admitWithGateOn(ctx, s.Queries, class)
}

func (s *TaskService) admitWithGateOn(ctx context.Context, q *db.Queries, class dispatch.AdmissionClass) error {
	if s == nil || s.DispatchAdmission == nil {
		return nil
	}
	// Only consult the global snapshot when a cap is actually configured, so a
	// deployment that enabled the gate structure but not thresholds pays no DB
	// read.
	if s.DispatchAdmission.MaxQueueDepth <= 0 && s.DispatchAdmission.MaxConcurrent <= 0 {
		return nil
	}
	if q == nil {
		q = s.Queries
		if q == nil {
			return nil
		}
	}
	row, err := q.SnapshotDispatchLoad(ctx)
	if err != nil {
		// Fail open on a load-snapshot read error: an infra hiccup must not
		// block work that the queue would otherwise accept. Logged for Ops.
		slog.Warn("dispatch admission: load snapshot failed, admitting", "error", err)
		return nil
	}
	load := dispatch.Load{QueueDepth: int(row.QueuedDepth), ActiveConcurrent: int(row.ActiveConcurrent)}

	deferralCount := int(s.admissionDeferrals.Load())
	dec := dispatch.Evaluate(s.DispatchAdmission.policy(), class, load, deferralCount)
	s.recordAdmission(class, dec)

	switch {
	case dec.Reject:
		// Reset the backoff chain: a rejection means the cap is blown and a
		// fresh wave must not inherit a warmed-up deferral counter.
		s.admissionDeferrals.Store(0)
		return ErrDispatchOverloaded
	case dec.Defer:
		s.admissionDeferrals.Add(1)
		return &dispatchDeferredError{retryAfter: dec.RetryAfter}
	default:
		// Admitted. Reset the consecutive-deferral counter so backoff does not
		// escalate across a healthy intermission.
		s.admissionDeferrals.Store(0)
		return nil
	}
}

// recordAdmission emits the gate decision to the shared metrics collector.
func (s *TaskService) recordAdmission(class dispatch.AdmissionClass, dec dispatch.Decision) {
	if s == nil || s.Metrics == nil {
		return
	}
	cls := string(class)
	if cls == "" {
		cls = string(dispatch.ClassStandard)
	}
	switch {
	case dec.Reject:
		s.Metrics.RecordAdmissionRejected(cls)
	case dec.Defer:
		s.Metrics.RecordAdmissionDeferred(cls)
	default:
		s.Metrics.RecordAdmissionAdmitted(cls)
	}
	if dec.NearLimit {
		s.Metrics.RecordAdmissionNearLimit(cls)
	}
}

// admissionClassForTrigger picks the admission class for an issue-minted task
// from its trigger. A run with no trigger comment is a direct/operator launch
// (assignment, quick-create, escalation) and is treated as critical so an
// overload cannot starve the very actions meant to fix it; a comment-triggered
// run is standard. Classes only feed the gate's reason/metrics labels — the
// hard caps and alert threshold are shared across classes.
func admissionClassForTrigger(triggerCommentID pgtype.UUID) dispatch.AdmissionClass {
	if !triggerCommentID.Valid {
		return dispatch.ClassCritical
	}
	return dispatch.ClassStandard
}
