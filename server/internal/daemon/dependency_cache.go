package daemon

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const codeReviewGraphVersion = "2.3.8"

// ownerPIDFile names the marker every provisioning lock carries. It lets a
// later task tell a live provisioner from one the kernel killed.
const ownerPIDFile = "owner.pid"

// acquireProvisionLock claims lock atomically. The owner PID is written into a
// staging directory first and that directory is renamed into place, so the
// lock is never observable without its owner recorded. Renaming onto a lock
// that already holds a marker fails, which is what makes the claim exclusive.
func acquireProvisionLock(lock string) error {
	staging, err := os.MkdirTemp(filepath.Dir(lock), ".lock-staging-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	pid := []byte(strconv.Itoa(os.Getpid()) + "\n")
	if err := os.WriteFile(filepath.Join(staging, ownerPIDFile), pid, 0o644); err != nil {
		return err
	}
	return os.Rename(staging, lock)
}

// provisionLockAbandoned reports whether the process that claimed lock is gone.
// A daemon restart delivers SIGTERM, which terminates the process without
// running deferred cleanup, so a lock outlives its owner. The cache root is
// shared by every task on the daemon, so one such lock would otherwise stall
// provisioning for all of them with no way to recover but manual deletion.
func provisionLockAbandoned(lock string) bool {
	raw, err := os.ReadFile(filepath.Join(lock, ownerPIDFile))
	if err != nil {
		// No marker: either a lock written by the pre-marker implementation or
		// one that lost its file. Neither has a reachable owner to wait for.
		return true
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || pid <= 0 {
		return true
	}
	if pid == os.Getpid() {
		return false
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return true
	}
	// Signal 0 probes for existence without disturbing the process. Only a
	// definitively absent process counts as abandoned: EPERM means the PID is
	// live under another user, and any other error is inconclusive, so in both
	// cases the lock is left alone.
	err = proc.Signal(syscall.Signal(0))
	if err == nil {
		return false
	}
	return errors.Is(err, os.ErrProcessDone) || errors.Is(err, syscall.ESRCH)
}

// awaitProvisionLock blocks until this process holds lock. A lock whose owner
// has died is reclaimed along with the partial venv it left behind, so a
// daemon restart during provisioning cannot strand every later task.
func awaitProvisionLock(lock, venv string) error {
	for {
		err := acquireProvisionLock(lock)
		if err == nil {
			return nil
		}
		if !errors.Is(err, os.ErrExist) {
			return err
		}
		if provisionLockAbandoned(lock) {
			_ = os.RemoveAll(venv)
			_ = os.RemoveAll(lock)
			continue
		}
		time.Sleep(25 * time.Millisecond)
	}
}

// ensureCodeReviewGraphCache provisions the pinned graph tool once per daemon
// cache root. Incomplete directories are removed so a later task can safely
// retry provisioning, and a lock whose owner died is reclaimed rather than
// waited on forever.
func ensureCodeReviewGraphCache(root string) (string, error) {
	venv := filepath.Join(root, "code-review-graph", codeReviewGraphVersion)
	if _, err := os.Stat(filepath.Join(venv, "READY")); err == nil {
		return venv, nil
	}
	lock := venv + ".lock"
	if err := os.MkdirAll(filepath.Dir(venv), 0o755); err != nil { return "", err }
	if err := awaitProvisionLock(lock, venv); err != nil { return "", err }
	defer os.RemoveAll(lock)
	if _, err := os.Stat(filepath.Join(venv, "READY")); err == nil { return venv, nil }
	_ = os.RemoveAll(venv)
	if err := os.MkdirAll(venv, 0o755); err != nil { return "", err }
	if out, err := exec.Command("python3", "-m", "venv", venv).CombinedOutput(); err != nil { _ = os.RemoveAll(venv); return "", fmt.Errorf("create graph venv: %w: %s", err, out) }
	pip := filepath.Join(venv, "bin", "pip")
	if out, err := exec.Command(pip, "install", "--quiet", "code-review-graph=="+codeReviewGraphVersion).CombinedOutput(); err != nil { _ = os.RemoveAll(venv); return "", fmt.Errorf("install graph package: %w: %s", err, out) }
	if err := os.WriteFile(filepath.Join(venv, "READY"), []byte(codeReviewGraphVersion+"\n"), 0o644); err != nil { _ = os.RemoveAll(venv); return "", err }
	return venv, nil
}
