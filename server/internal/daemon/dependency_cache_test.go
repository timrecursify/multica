package daemon

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// deadPID returns the PID of a process that has run to completion and been
// reaped, so signalling it is guaranteed to report an absent process.
func deadPID(t *testing.T) int {
	t.Helper()
	cmd := exec.Command("sh", "-c", "exit 0")
	if err := cmd.Run(); err != nil {
		t.Fatalf("run probe process: %v", err)
	}
	return cmd.Process.Pid
}

func TestAcquireProvisionLockIsExclusive(t *testing.T) {
	dir := t.TempDir()
	lock := filepath.Join(dir, "2.3.8.lock")

	if err := acquireProvisionLock(lock); err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	if _, err := os.Stat(filepath.Join(lock, ownerPIDFile)); err != nil {
		t.Fatalf("owner marker missing after acquire: %v", err)
	}
	err := acquireProvisionLock(lock)
	if err == nil {
		t.Fatal("second acquire succeeded; lock is not exclusive")
	}
	if !os.IsExist(err) {
		t.Fatalf("second acquire error = %v, want an already-exists error", err)
	}
}

func TestAcquireProvisionLockLeavesNoStagingDirs(t *testing.T) {
	dir := t.TempDir()
	lock := filepath.Join(dir, "2.3.8.lock")

	if err := acquireProvisionLock(lock); err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	if err := acquireProvisionLock(lock); err == nil {
		t.Fatal("second acquire succeeded; lock is not exclusive")
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read cache dir: %v", err)
	}
	for _, e := range entries {
		if e.Name() != "2.3.8.lock" {
			t.Errorf("leftover entry after failed acquire: %s", e.Name())
		}
	}
}

func TestProvisionLockAbandonedDetectsDeadOwner(t *testing.T) {
	dir := t.TempDir()
	lock := filepath.Join(dir, "2.3.8.lock")
	if err := os.MkdirAll(lock, 0o755); err != nil {
		t.Fatalf("create lock: %v", err)
	}
	pid := deadPID(t)
	marker := []byte(strconv.Itoa(pid) + "\n")
	if err := os.WriteFile(filepath.Join(lock, ownerPIDFile), marker, 0o644); err != nil {
		t.Fatalf("write owner marker: %v", err)
	}

	if !provisionLockAbandoned(lock) {
		t.Fatalf("lock owned by exited pid %d reported as live", pid)
	}
}

func TestProvisionLockAbandonedKeepsLiveOwner(t *testing.T) {
	dir := t.TempDir()
	lock := filepath.Join(dir, "2.3.8.lock")
	if err := acquireProvisionLock(lock); err != nil {
		t.Fatalf("acquire: %v", err)
	}

	if provisionLockAbandoned(lock) {
		t.Fatal("lock owned by this live process reported as abandoned")
	}
}

func TestProvisionLockAbandonedTreatsMissingMarkerAsAbandoned(t *testing.T) {
	dir := t.TempDir()
	lock := filepath.Join(dir, "2.3.8.lock")
	// A lock directory written by the pre-marker implementation.
	if err := os.MkdirAll(lock, 0o755); err != nil {
		t.Fatalf("create lock: %v", err)
	}

	if !provisionLockAbandoned(lock) {
		t.Fatal("markerless lock reported as live; it would stall every task")
	}
}

func TestAwaitProvisionLockReclaimsAbandonedLock(t *testing.T) {
	root := t.TempDir()
	venv := filepath.Join(root, "code-review-graph", codeReviewGraphVersion)
	if err := os.MkdirAll(venv, 0o755); err != nil {
		t.Fatalf("create venv dir: %v", err)
	}
	lock := venv + ".lock"
	if err := os.MkdirAll(lock, 0o755); err != nil {
		t.Fatalf("create lock: %v", err)
	}
	marker := []byte(strconv.Itoa(deadPID(t)) + "\n")
	if err := os.WriteFile(filepath.Join(lock, ownerPIDFile), marker, 0o644); err != nil {
		t.Fatalf("write owner marker: %v", err)
	}

	done := make(chan error, 1)
	go func() { done <- awaitProvisionLock(lock, venv) }()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("awaitProvisionLock: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("awaitProvisionLock blocked on a lock whose owner had exited")
	}

	if _, err := os.Stat(venv); !os.IsNotExist(err) {
		t.Error("partial venv from the dead owner was not discarded")
	}
	if provisionLockAbandoned(lock) {
		t.Error("reclaimed lock is not owned by this process")
	}
}
