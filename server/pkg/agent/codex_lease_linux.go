//go:build linux

package agent

import (
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// codexProcessLease deliberately records only process identity and diagnostic
// ids. Environment, command lines, and prompts can contain secrets.
type codexProcessLease struct {
	PGID         int    `json:"pgid"`
	ProcessStart uint64 `json:"process_start"`
	OwnerPID     int    `json:"owner_pid"`
	OwnerStart   uint64 `json:"owner_start"`
	DaemonID     string `json:"daemon_id"`
	TaskID       string `json:"task_id"`
	RuntimeID    string `json:"runtime_id"`
}

func procStartTime(pid int) (uint64, error) {
	b, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return 0, err
	}
	// Field 2 is parenthesized and may contain spaces. Everything after ") "
	// starts at field 3; starttime is field 22, hence index 19 here.
	i := strings.LastIndex(string(b), ") ")
	if i < 0 {
		return 0, errors.New("malformed proc stat")
	}
	f := strings.Fields(string(b)[i+2:])
	if len(f) <= 19 {
		return 0, errors.New("short proc stat")
	}
	return strconv.ParseUint(f[19], 10, 64)
}

func leasePath(dir string, pgid int) string { return filepath.Join(dir, strconv.Itoa(pgid)+".json") }

func writeCodexProcessLease(dir string, cfg Config, pgid int) (string, error) {
	if dir == "" {
		return "", nil
	}
	start, err := procStartTime(pgid)
	if err != nil {
		return "", err
	}
	ownerStart, err := procStartTime(os.Getpid())
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	lease := codexProcessLease{PGID: pgid, ProcessStart: start, OwnerPID: os.Getpid(), OwnerStart: ownerStart, DaemonID: cfg.DaemonID, TaskID: cfg.TaskID, RuntimeID: cfg.RuntimeID}
	b, err := json.Marshal(lease)
	if err != nil {
		return "", err
	}
	path := leasePath(dir, pgid)
	tmp, err := os.CreateTemp(dir, ".codex-lease-")
	if err != nil {
		return "", err
	}
	if _, err = tmp.Write(b); err == nil {
		err = tmp.Chmod(0600)
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(tmp.Name())
		return "", err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		_ = os.Remove(tmp.Name())
		return "", err
	}
	return path, nil
}

func removeCodexProcessLease(path string) {
	if path != "" {
		_ = os.Remove(path)
	}
}

// RecoverCodexProcessLeases only considers files created by this daemon. A
// start-time match prevents PID/PGID reuse from ever targeting a new process.
func RecoverCodexProcessLeases(dir string, logger *slog.Logger) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return
	}
	if err != nil {
		logger.Warn("codex lease sweep failed", "error", err)
		return
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		b, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var l codexProcessLease
		if json.Unmarshal(b, &l) != nil || l.PGID <= 0 {
			_ = os.Remove(path)
			continue
		}
		start, err := procStartTime(l.PGID)
		if err != nil || start != l.ProcessStart {
			logger.Info("codex lease discarded", "pgid", l.PGID, "reason", "process_identity_mismatch")
			_ = os.Remove(path)
			continue
		}
		ownerStart, ownerErr := procStartTime(l.OwnerPID)
		if ownerErr == nil && ownerStart == l.OwnerStart {
			continue
		}
		logger.Warn("codex orphan detected", "pgid", l.PGID, "task_id", l.TaskID, "runtime_id", l.RuntimeID, "owner_pid", l.OwnerPID)
		err = syscall.Kill(-l.PGID, syscall.SIGKILL)
		if err != nil && !errors.Is(err, syscall.ESRCH) {
			logger.Warn("codex orphan signal failed", "pgid", l.PGID, "error", err)
			continue
		}
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			if err := syscall.Kill(-l.PGID, 0); errors.Is(err, syscall.ESRCH) {
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		if err := syscall.Kill(-l.PGID, 0); errors.Is(err, syscall.ESRCH) {
			_ = os.Remove(path)
			logger.Info("codex orphan reaped", "pgid", l.PGID, "task_id", l.TaskID)
		} else {
			logger.Warn("codex orphan remains after signal", "pgid", l.PGID)
		}
	}
}
