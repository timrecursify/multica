//go:build linux

package agent

import (
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func writeTestCodexLease(t *testing.T, dir string, lease codexProcessLease) string {
	t.Helper()
	b, err := json.Marshal(lease)
	if err != nil {
		t.Fatal(err)
	}
	path := leasePath(dir, lease.PGID)
	if err := os.WriteFile(path, b, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestRecoverCodexProcessLeasesReapsOnlyDeadOwner(t *testing.T) {
	dir := t.TempDir()
	cmd := exec.Command("sh", "-c", "sleep 30 & wait")
	configureProcessGroup(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { signalProcessGroup(cmd.Process, 9); _ = cmd.Wait() })
	start, err := procStartTime(cmd.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	path := writeTestCodexLease(t, dir, codexProcessLease{PGID: cmd.Process.Pid, ProcessStart: start, OwnerPID: 999999, OwnerStart: 1, TaskID: "task"})
	RecoverCodexProcessLeases(dir, slog.New(slog.NewTextHandler(io.Discard, nil)))
	_ = cmd.Wait()
	RecoverCodexProcessLeases(dir, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("lease remains after reap: %v", err)
	}
}

func TestRecoverCodexProcessLeasesLeavesLiveOwnerAndDropsMismatchedIdentity(t *testing.T) {
	dir := t.TempDir()
	cmd := exec.Command("sleep", "30")
	configureProcessGroup(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { signalProcessGroup(cmd.Process, 9); _ = cmd.Wait() })
	start, err := procStartTime(cmd.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	ownerStart, err := procStartTime(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	live := writeTestCodexLease(t, dir, codexProcessLease{PGID: cmd.Process.Pid, ProcessStart: start, OwnerPID: os.Getpid(), OwnerStart: ownerStart})
	mismatch := filepath.Join(dir, "mismatch.json")
	b, _ := json.Marshal(codexProcessLease{PGID: cmd.Process.Pid, ProcessStart: start + 1, OwnerPID: 999999, OwnerStart: 1})
	if err := os.WriteFile(mismatch, b, 0600); err != nil {
		t.Fatal(err)
	}
	RecoverCodexProcessLeases(dir, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if _, err := procStartTime(cmd.Process.Pid); err != nil {
		t.Fatalf("live-owner process was signalled: %v", err)
	}
	if _, err := os.Stat(live); err != nil {
		t.Fatalf("live lease removed: %v", err)
	}
	if _, err := os.Stat(mismatch); !os.IsNotExist(err) {
		t.Fatalf("mismatched lease remains: %v", err)
	}
	// Avoid a false-positive from an async kernel group cleanup in very busy CI.
	time.Sleep(10 * time.Millisecond)
}
