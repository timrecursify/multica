package daemon

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWriteTaskTempTerminalMarker(t *testing.T) {
	taskTempDir, err := os.MkdirTemp(socketSafeTempBaseDir(), "multica-task-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(taskTempDir) })

	completedAt := time.Date(2026, 9, 1, 3, 45, 0, 123456789, time.UTC)
	if err := writeTaskTempTerminalMarker(taskTempDir, "task-123", "workspace-456", completedAt); err != nil {
		t.Fatalf("writeTaskTempTerminalMarker: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(taskTempDir, taskTempTerminalMarkerFile))
	if err != nil {
		t.Fatalf("read marker: %v", err)
	}
	var got struct {
		Version     int       `json:"version"`
		TaskID      string    `json:"task_id"`
		WorkspaceID string    `json:"workspace_id"`
		Workspace   string    `json:"workspace"`
		CompletedAt time.Time `json:"completed_at"`
	}
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("decode marker %q: %v", data, err)
	}
	if got.Version != 1 || got.TaskID != "task-123" || got.WorkspaceID != "workspace-456" || got.Workspace != taskTempDir || !got.CompletedAt.Equal(completedAt) {
		t.Fatalf("marker = %+v, want version/task/workspace/path/time", got)
	}
	if matches, _ := filepath.Glob(filepath.Join(taskTempDir, ".multica-task-terminal-v1.tmp-*")); len(matches) != 0 {
		t.Fatalf("atomic temporary files remain: %v", matches)
	}
}

func TestWriteTaskTempTerminalMarkerRejectsUnsafePaths(t *testing.T) {
	taskTempDir, err := os.MkdirTemp(socketSafeTempBaseDir(), "multica-task-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(taskTempDir) })

	nested := filepath.Join(taskTempDir, "nested")
	if err := os.Mkdir(nested, 0o700); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	cases := []struct {
		name string
		path string
	}{
		{name: "nested", path: nested},
		{name: "outside", path: outside},
		{name: "empty", path: ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := writeTaskTempTerminalMarker(tc.path, "task", "workspace", time.Now()); err == nil {
				t.Fatalf("writeTaskTempTerminalMarker(%q) unexpectedly succeeded", tc.path)
			}
		})
	}

	symlink := filepath.Join(socketSafeTempBaseDir(), "multica-task-marker-link-test")
	if err := os.Symlink(taskTempDir, symlink); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(symlink) })
	if err := writeTaskTempTerminalMarker(symlink, "task", "workspace", time.Now()); err == nil {
		t.Fatal("symlink task temp dir unexpectedly accepted")
	}
}

func TestCleanupTaskTempDirRestoresMarkerAfterPartialRemoval(t *testing.T) {
	dir, err := os.MkdirTemp(socketSafeTempBaseDir(), "multica-task-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	payload := filepath.Join(dir, "payload")
	if err := os.WriteFile(payload, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	result := TaskResult{TempDir: dir}
	task := Task{ID: "task-partial", WorkspaceID: "workspace-partial"}
	remove := func(path string) error {
		if filepath.Base(path) == "payload" {
			_ = os.Remove(filepath.Join(dir, taskTempTerminalMarkerFile))
			return errors.New("simulated root-owned child")
		}
		return os.RemoveAll(path)
	}
	d := &Daemon{}
	d.cleanupTaskTempDirWith(task, result, true, slog.New(slog.NewTextHandler(io.Discard, nil)), remove)
	if _, err := os.Stat(payload); err != nil {
		t.Fatalf("partial cleanup removed protected payload: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, taskTempTerminalMarkerFile)); err != nil {
		t.Fatalf("terminal marker was not restored after partial cleanup: %v", err)
	}
}

func TestCleanupTaskTempDirDoesNotMarkUnterminalizedResult(t *testing.T) {
	dir, err := os.MkdirTemp(socketSafeTempBaseDir(), "multica-task-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	result := TaskResult{TempDir: dir}
	task := Task{ID: "task-interrupted", WorkspaceID: "workspace-interrupted"}
	remove := func(string) error { return nil }
	d := &Daemon{}
	d.cleanupTaskTempDirWith(task, result, false, slog.New(slog.NewTextHandler(io.Discard, nil)), remove)
	if _, err := os.Stat(filepath.Join(dir, taskTempTerminalMarkerFile)); !os.IsNotExist(err) {
		t.Fatalf("interrupted result left terminal marker, stat err=%v", err)
	}
}

func TestWriteTaskTempTerminalMarkerReportsDurabilityPreparationError(t *testing.T) {
	dir, err := os.MkdirTemp(socketSafeTempBaseDir(), "multica-task-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = os.Chmod(dir, 0o700)
		_ = os.RemoveAll(dir)
	})
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	if err := writeTaskTempTerminalMarker(dir, "task-readonly", "workspace-readonly", time.Now()); err == nil {
		t.Fatal("writeTaskTempTerminalMarker unexpectedly succeeded in read-only directory")
	}
}
