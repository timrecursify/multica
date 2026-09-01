package daemon

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const taskTempTerminalMarkerFile = ".multica-task-terminal-v1"

// taskTempTerminalMarker is the durable proof that a task temp directory no
// longer belongs to an in-flight task. workspace is retained as the absolute
// temp directory path for compatibility with the Sentinel disk-GC consumer;
// workspace_id carries the Multica workspace identity for producers and other
// consumers that need it.
type taskTempTerminalMarker struct {
	Version     int       `json:"version"`
	TaskID      string    `json:"task_id"`
	WorkspaceID string    `json:"workspace_id"`
	Workspace   string    `json:"workspace"`
	CompletedAt time.Time `json:"completed_at"`
}

func resolveManagedTaskTempDir(taskTempDir string) (string, error) {
	base, err := filepath.EvalSymlinks(socketSafeTempBaseDir())
	if err != nil {
		return "", fmt.Errorf("resolve temp root: %w", err)
	}
	candidate, err := filepath.EvalSymlinks(taskTempDir)
	if err != nil {
		return "", fmt.Errorf("resolve task temp dir: %w", err)
	}
	info, err := os.Lstat(taskTempDir)
	if err != nil {
		return "", fmt.Errorf("stat task temp dir: %w", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("task temp marker target is not a real directory")
	}
	rel, err := filepath.Rel(base, candidate)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || strings.Contains(rel, string(filepath.Separator)) || !strings.HasPrefix(filepath.Base(candidate), "multica-task-") {
		return "", fmt.Errorf("task temp dir %q is outside the managed temp root", taskTempDir)
	}
	return candidate, nil
}

func writeAtomicTaskTempMarker(dir string, data []byte) error {
	tmp, err := os.CreateTemp(dir, ".multica-task-terminal-v1.tmp-")
	if err != nil {
		return fmt.Errorf("create task temp marker: %w", err)
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if err := tmp.Chmod(0o644); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("chmod task temp marker: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write task temp marker: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("sync task temp marker: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close task temp marker: %w", err)
	}
	if err := os.Rename(tmpName, filepath.Join(dir, taskTempTerminalMarkerFile)); err != nil {
		return fmt.Errorf("publish task temp marker: %w", err)
	}
	parent, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("open task temp marker directory: %w", err)
	}
	if err := parent.Sync(); err != nil {
		_ = parent.Close()
		return fmt.Errorf("sync task temp marker directory: %w", err)
	}
	if err := parent.Close(); err != nil {
		return fmt.Errorf("close task temp marker directory: %w", err)
	}
	return nil
}

func removeTaskTempDirContents(dir string, remove func(string) error) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	var firstErr error
	for _, entry := range entries {
		if entry.Name() == taskTempTerminalMarkerFile {
			continue
		}
		if err := remove(filepath.Join(dir, entry.Name())); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// writeTaskTempTerminalMarker atomically records a terminal task temp
// directory. The target must be a direct, daemon-created child of the system
// temp root; this prevents a malformed task path from turning the marker into
// an arbitrary file write.
func writeTaskTempTerminalMarker(taskTempDir, taskID, workspaceID string, completedAt time.Time) error {
	taskTempDir = strings.TrimSpace(taskTempDir)
	taskID = strings.TrimSpace(taskID)
	workspaceID = strings.TrimSpace(workspaceID)
	if taskTempDir == "" || taskID == "" || workspaceID == "" {
		return errors.New("task temp marker requires task directory, task id, and workspace id")
	}
	if completedAt.IsZero() {
		completedAt = time.Now().UTC()
	} else {
		completedAt = completedAt.UTC()
	}

	candidate, err := resolveManagedTaskTempDir(taskTempDir)
	if err != nil {
		return err
	}

	marker := taskTempTerminalMarker{
		Version:     1,
		TaskID:      taskID,
		WorkspaceID: workspaceID,
		Workspace:   candidate,
		CompletedAt: completedAt,
	}
	data, err := json.Marshal(marker)
	if err != nil {
		return fmt.Errorf("marshal task temp marker: %w", err)
	}
	return writeAtomicTaskTempMarker(candidate, data)
}
