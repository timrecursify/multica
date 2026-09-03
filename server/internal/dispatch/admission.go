package dispatch

import (
	"fmt"
	"math"
	"time"
)

// AdmissionClass ranks a task by how much overload it may tolerate before
// being deferred or rejected. Critical work (operator-triggered, escalations,
// direct member mentions) is admitted aggressively to protect an outage from
// starving exactly the channels meant to fix it; best-effort work (bulk QC /
// backfill waves) is the first to be held back when load climbs.
type AdmissionClass string

const (
	ClassCritical   AdmissionClass = "critical"
	ClassStandard   AdmissionClass = "standard"
	ClassBestEffort AdmissionClass = "best_effort"
)

// Load is a point-in-time snapshot of dispatch admission pressure, supplied by
// the owner at evaluation time. QueueDepth is the number of tasks currently
// queued; ActiveConcurrent is the number being actively worked. Both count
// toward the decision: a deep queue indicates a large incoming wave, while
// high worker utilization indicates the system is already at capacity.
type Load struct {
	QueueDepth       int
	ActiveConcurrent int
}

// AdmissionPolicy is the operator-configurable admission policy (MINT-5).
// A zero value means "not configured" — the gate is disabled and everything is
// admitted. Thresholds are shared across classes; classes only change how
// close to a threshold a request may sit before it is held back. Keeping the
// policy in the dependency-free dispatch package means it can be unit tested
// in isolation and reused by whatever dispatcher owns enforcement.
type AdmissionPolicy struct {
	// MaxQueueDepth rejects new work once the queue exceeds this many pending
	// tasks (the hard cap). This bounds the "batch wave" scenario: a loader may
	// keep enqueueing below the cap, and once the queue is this deep the queue
	// drains before more is accepted.
	MaxQueueDepth int
	// MaxConcurrent rejects new work once this many tasks are actively worked
	// (the hard cap). This bounds the worker-utilization scenario.
	MaxConcurrent int
	// AlertThreshold is the "near-limit" watermark, as a fraction of the
	// smaller configured cap, in [0, 1]. At or above it the gate defers new
	// work with exponential backoff and sets NearLimit so Ops can alert before
	// the hard cap is reached. 0 disables both the defer band and the alert.
	AlertThreshold float64
	// BackoffBase is the base exponential backoff duration used for deferred
	// work. Each consecutive deferral multiplies it by 2.
	BackoffBase time.Duration
	// BackoffCap is the maximum Retry-After a deferred task may reach.
	BackoffCap time.Duration
}

// Decision is the outcome of an admission evaluation.
type Decision struct {
	// Admit is true when the task may be enqueued now.
	Admit bool
	// Defer is true when the task is safe to retry later — load is at or
	// above the near-limit watermark but below the hard cap. Honor RetryAfter
	// before retrying.
	Defer bool
	// Reject is true when the task is refused outright — load is beyond the
	// hard cap, so retrying immediately is useless and only adds pressure.
	Reject bool
	// RetryAfter is the exponential-backoff duration to honor before the next
	// attempt (valid only when Defer is true).
	RetryAfter time.Duration
	// NearLimit is true when load is at or above the AlertThreshold watermark.
	NearLimit bool
	// Reason is a stable machine string identifying the ruling, for metrics
	// and structured logs.
	Reason string
}

// Evaluate produces the admission decision for a class against the current
// load. It is a pure function so it is trivially unit testable and safe to
// share across dispatchers. Capacity follows the smaller configured cap;
// overload is judged against whichever cap is configured.
func Evaluate(cfg AdmissionPolicy, class AdmissionClass, load Load, deferralCount int) Decision {
	if cfg.MaxQueueDepth <= 0 && cfg.MaxConcurrent <= 0 {
		// Unconfigured gate: admit everything.
		return Decision{Admit: true, Reason: "gate_disabled"}
	}
	if class == "" {
		class = ClassStandard
	}

	queueOver := cfg.MaxQueueDepth > 0 && load.QueueDepth >= cfg.MaxQueueDepth
	concurrentOver := cfg.MaxConcurrent > 0 && load.ActiveConcurrent >= cfg.MaxConcurrent

	// Hard overload beyond a configured cap → reject outright.
	if queueOver || concurrentOver {
		return Decision{
			Reject:    true,
			NearLimit: true,
			Reason:    rejectReason(cfg, class, load, queueOver, concurrentOver),
		}
	}

	near := nearLimit(cfg, load)
	base, cap := normalizedBackoff(cfg)
	retry := clampedRetry(base, cap, deferralCount)

	// Near the limit → defer with exponential backoff so we avoid reaching the
	// hard cap and shed pressure proactively (this is the backoff strategy).
	if near {
		return Decision{
			Defer:      true,
			RetryAfter: retry,
			NearLimit:  true,
			Reason:     fmt.Sprintf("defer_%s_near_limit_retry_after_%s", classify(class), retry),
		}
	}

	return Decision{
		Admit:      true,
		RetryAfter: retry,
		Reason:     fmt.Sprintf("admit_%s", classify(class)),
	}
}

// deferRetryAfter returns the capped exponential backoff for the given number
// of consecutive deferrals. Exported for callers that track backoff separately.
func deferRetryAfter(base, cap time.Duration, n int) time.Duration {
	b, c := normalizedBackoff(AdmissionPolicy{BackoffBase: base, BackoffCap: cap})
	return clampedRetry(b, c, n)
}

// nearLimit reports whether either resource sits at or above the alert
// threshold of its own configured cap. Queue depth and active concurrency are
// different units and must not be compared to one another (or to the smaller
// of the two caps).
func nearLimit(cfg AdmissionPolicy, load Load) bool {
	if cfg.AlertThreshold <= 0 {
		return false
	}
	queueNear := cfg.MaxQueueDepth > 0 &&
		float64(load.QueueDepth) >= cfg.AlertThreshold*float64(cfg.MaxQueueDepth)
	activeNear := cfg.MaxConcurrent > 0 &&
		float64(load.ActiveConcurrent) >= cfg.AlertThreshold*float64(cfg.MaxConcurrent)
	return queueNear || activeNear
}

func normalizedBackoff(cfg AdmissionPolicy) (base, cap time.Duration) {
	base = cfg.BackoffBase
	cap = cfg.BackoffCap
	if base <= 0 {
		base = time.Second
	}
	if cap <= 0 {
		cap = base
	}
	if cap < base {
		cap = base
	}
	return base, cap
}

func clampedRetry(base, cap time.Duration, n int) time.Duration {
	if n < 0 {
		n = 0
	}
	d := base * time.Duration(pow2(n))
	if d > cap {
		d = cap
	}
	if d < 0 {
		d = 0
	}
	return d
}

func pow2(n int) int {
	if n <= 0 {
		return 1
	}
	if n > 16 {
		n = 16 // guard against overflow on very long deferral chains
	}
	return 1 << uint(n)
}

func rejectReason(cfg AdmissionPolicy, class AdmissionClass, load Load, queueOver, concurrentOver bool) string {
	cls := classify(class)
	switch {
	case queueOver && concurrentOver:
		return fmt.Sprintf("reject_%s_queue_and_concurrent_capacity_exceeded", cls)
	case queueOver:
		return fmt.Sprintf("reject_%s_queue_depth_exceeded", cls)
	default:
		return fmt.Sprintf("reject_%s_concurrent_capacity_exceeded", cls)
	}
}

func classify(c AdmissionClass) AdmissionClass {
	switch c {
	case ClassCritical, ClassStandard, ClassBestEffort:
		return c
	default:
		return ClassStandard
	}
}

// RetryAfterSeconds is a convenience for the HTTP contract: the Retry-After
// value in whole seconds (rounded up), so a 0 retry still reads 0.
func (d Decision) RetryAfterSeconds() int64 {
	return int64(math.Ceil(float64(d.RetryAfter) / float64(time.Second)))
}
