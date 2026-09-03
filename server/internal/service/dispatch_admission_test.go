package service

import (
	"context"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/dispatch"
)

func TestAdmitWithGate_DisabledWhenPolicyNil(t *testing.T) {
	var s *TaskService
	if err := s.admitWithGate(context.Background(), dispatch.ClassStandard); err != nil {
		t.Fatalf("nil receiver must admit, got %v", err)
	}
	s = &TaskService{}
	if err := s.admitWithGate(context.Background(), dispatch.ClassStandard); err != nil {
		t.Fatalf("nil policy must admit, got %v", err)
	}
}

func TestAdmitWithGate_DisabledWhenZeroPolicy(t *testing.T) {
	s := &TaskService{DispatchAdmission: &DispatchAdmissionPolicy{}}
	if err := s.admitWithGate(context.Background(), dispatch.ClassStandard); err != nil {
		t.Fatalf("zero policy must admit, got %v", err)
	}
}

func TestAdmitWithGate_FailsOpenWithoutSnapshotSource(t *testing.T) {
	// Nil Queries means snapshotDispatchLoad returns an empty load without an
	// error, so empty load (0/0) is below any cap and the gate admits.
	s := &TaskService{
		DispatchAdmission: &DispatchAdmissionPolicy{MaxQueueDepth: 10},
	}
	if err := s.admitWithGate(context.Background(), dispatch.ClassStandard); err != nil {
		t.Fatalf("no snapshot source must admit, got %v", err)
	}
}

func TestAdmitWithGate_DeferralCounterReset(t *testing.T) {
	s := &TaskService{DispatchAdmission: &DispatchAdmissionPolicy{MaxQueueDepth: 10}}
	// First call with empty load admits and resets the counter to 0.
	if err := s.admitWithGate(context.Background(), dispatch.ClassStandard); err != nil {
		t.Fatalf("admit failed: %v", err)
	}
	if got := s.admissionDeferrals.Load(); got != 0 {
		t.Fatalf("after admit deferrals = %d, want 0", got)
	}
}

func TestDispatchAdmissionPolicy_PolicyMapping(t *testing.T) {
	p := &DispatchAdmissionPolicy{
		MaxQueueDepth:  100,
		MaxConcurrent:  20,
		AlertThreshold: 0.8,
		BackoffBase:    time.Second,
		BackoffCap:     8 * time.Second,
	}
	got := p.policy()
	if got.MaxQueueDepth != 100 || got.MaxConcurrent != 20 || got.AlertThreshold != 0.8 {
		t.Fatalf("policy mapping mismatch: %+v", got)
	}
	if got.BackoffBase != time.Second || got.BackoffCap != 8*time.Second {
		t.Fatalf("policy mapping backoff mismatch: %+v", got)
	}
}
