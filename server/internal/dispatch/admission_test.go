package dispatch

import (
	"testing"
	"time"
)

func TestEvaluate_UnconfiguredGateAdmits(t *testing.T) {
	d := Evaluate(AdmissionPolicy{}, ClassStandard, Load{QueueDepth: 5000, ActiveConcurrent: 50}, 0)
	if !d.Admit {
		t.Fatalf("unconfigured gate must admit, got %+v", d)
	}
	if d.Reject || d.Defer {
		t.Fatalf("unconfigured gate must neither reject nor defer, got %+v", d)
	}
	if d.NearLimit {
		t.Fatalf("unconfigured gate must not emit near-limit, got %+v", d)
	}
}

func TestEvaluate_RejectsBeyondHardQueueCap(t *testing.T) {
	cfg := AdmissionPolicy{MaxQueueDepth: 1000, MaxConcurrent: 50}
	d := Evaluate(cfg, ClassStandard, Load{QueueDepth: 1000, ActiveConcurrent: 10}, 0)
	if !d.Reject {
		t.Fatalf("queue depth == cap must reject, got %+v", d)
	}
	if d.Admit || d.Defer {
		t.Fatalf("reject must be exclusive, got %+v", d)
	}
	if !d.NearLimit {
		t.Fatalf("overload must be near-limit, got %+v", d)
	}
}

func TestEvaluate_RejectsBeyondHardConcurrentCap(t *testing.T) {
	cfg := AdmissionPolicy{MaxQueueDepth: 1000, MaxConcurrent: 50}
	d := Evaluate(cfg, ClassStandard, Load{QueueDepth: 10, ActiveConcurrent: 50}, 0)
	if !d.Reject {
		t.Fatalf("concurrent == cap must reject, got %+v", d)
	}
	if d.Admit || d.Defer {
		t.Fatalf("reject must be exclusive, got %+v", d)
	}
}

func TestEvaluate_AdmitsBelowThreshold(t *testing.T) {
	cfg := AdmissionPolicy{MaxQueueDepth: 1000, MaxConcurrent: 50, AlertThreshold: 0.8}
	d := Evaluate(cfg, ClassStandard, Load{QueueDepth: 10, ActiveConcurrent: 5}, 0)
	if !d.Admit {
		t.Fatalf("low load must admit, got %+v", d)
	}
	if d.NearLimit {
		t.Fatalf("low load must not be near-limit, got %+v", d)
	}
}

func TestEvaluate_DefersAtNearLimitThreshold(t *testing.T) {
	cfg := AdmissionPolicy{MaxQueueDepth: 1000, MaxConcurrent: 100, AlertThreshold: 0.8}
	d := Evaluate(cfg, ClassStandard, Load{QueueDepth: 0, ActiveConcurrent: 80}, 0)
	if !d.Defer {
		t.Fatalf("concurrent 80/100 at 0.8 threshold must defer, got %+v", d)
	}
	if d.Admit || d.Reject {
		t.Fatalf("defer must be exclusive, got %+v", d)
	}
	if !d.NearLimit {
		t.Fatalf("at-alert load must be near-limit, got %+v", d)
	}
	if d.RetryAfter <= 0 {
		t.Fatalf("defer must carry a positive RetryAfter, got %+v", d)
	}
}

func TestEvaluate_NearLimitUsesEachResourceCap(t *testing.T) {
	// Queue and active-worker counts are distinct units. A busy worker pool
	// must trigger the alert even when the queue cap is much larger, and vice
	// versa.
	cfg := AdmissionPolicy{MaxQueueDepth: 1000, MaxConcurrent: 50, AlertThreshold: 0.8}
	if d := Evaluate(cfg, ClassStandard, Load{QueueDepth: 10, ActiveConcurrent: 40}, 0); !d.Defer || !d.NearLimit {
		t.Fatalf("active utilization should trigger near-limit independently: %+v", d)
	}
	if d := Evaluate(cfg, ClassStandard, Load{QueueDepth: 800, ActiveConcurrent: 1}, 0); !d.Defer || !d.NearLimit {
		t.Fatalf("queue utilization should trigger near-limit independently: %+v", d)
	}
	if d := Evaluate(cfg, ClassStandard, Load{QueueDepth: 799, ActiveConcurrent: 39}, 0); !d.Admit || d.NearLimit {
		t.Fatalf("below both resource thresholds should admit: %+v", d)
	}
}

func TestEvaluate_CriticalStillDefersAtNearLimit(t *testing.T) {
	// Critical class does not bypass the near-limit defer fold — it shares the
	// policy's thresholds; class only feeds the reason string. The alert exists
	// so operators rehearse the wave before any class hits a hard reject.
	cfg := AdmissionPolicy{MaxQueueDepth: 100, MaxConcurrent: 10, AlertThreshold: 0.9}
	d := Evaluate(cfg, ClassCritical, Load{QueueDepth: 0, ActiveConcurrent: 9}, 0)
	if !d.Defer || !d.NearLimit {
		t.Fatalf("critical at near-limit must still defer, got %+v", d)
	}
}

func TestEvaluate_ExponentialBackoffCaps(t *testing.T) {
	cfg := AdmissionPolicy{
		MaxQueueDepth: 1000,
		BackoffBase:   1 * time.Second,
		BackoffCap:    8 * time.Second,
	}
	if got, want := deferRetryAfter(cfg.BackoffBase, cfg.BackoffCap, 0), 1*time.Second; got != want {
		t.Fatalf("defer 0 = %v, want %v", got, want)
	}
	if got, want := deferRetryAfter(cfg.BackoffBase, cfg.BackoffCap, 1), 2*time.Second; got != want {
		t.Fatalf("defer 1 = %v, want %v", got, want)
	}
	if got, want := deferRetryAfter(cfg.BackoffBase, cfg.BackoffCap, 2), 4*time.Second; got != want {
		t.Fatalf("defer 2 = %v, want %v", got, want)
	}
	// The third deferral would be 8s exactly at the cap; the fourth would be
	// 16s but is capped at 8s.
	if got, want := deferRetryAfter(cfg.BackoffBase, cfg.BackoffCap, 3), 8*time.Second; got != want {
		t.Fatalf("defer 3 = %v, want %v", got, want)
	}
	if got, want := deferRetryAfter(cfg.BackoffBase, cfg.BackoffCap, 10), 8*time.Second; got != want {
		t.Fatalf("defer 10 = %v, want %v", got, want)
	}
}

func TestEvaluate_ClassDefaultsToStandard(t *testing.T) {
	d := Evaluate(AdmissionPolicy{MaxQueueDepth: 1}, "", Load{QueueDepth: 0, ActiveConcurrent: 0}, 0)
	if !d.Admit {
		t.Fatalf("empty class with headroom must admit, got %+v", d)
	}
}

func TestRetryAfterSeconds(t *testing.T) {
	d := Decision{RetryAfter: 2*time.Second + 500*time.Millisecond}
	if got := d.RetryAfterSeconds(); got != 3 {
		t.Fatalf("RetryAfterSeconds = %d, want 3 (ceil)", got)
	}
	zero := Decision{}
	if got := zero.RetryAfterSeconds(); got != 0 {
		t.Fatalf("zero RetryAfterSeconds = %d, want 0", got)
	}
}
