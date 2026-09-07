package daemon

import (
	"bytes"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTaskWorkdirReclaimable(t *testing.T) {
	workDir := "/workspaces/ws/12345678/workdir"
	tests := []struct {
		name string
		task *TaskGCStatus
		want bool
	}{
		{"completed with PR", &TaskGCStatus{Status: "completed", WorkDir: workDir, PRURL: "https://example.test/pr/1"}, true},
		{"completed without expected PR", &TaskGCStatus{Status: "completed", WorkDir: workDir}, true},
		{"completed branch missing PR", &TaskGCStatus{Status: "completed", WorkDir: workDir, BranchName: "feature"}, false},
		{"failed needs no PR", &TaskGCStatus{Status: "failed", WorkDir: workDir, BranchName: "feature"}, true},
		{"running", &TaskGCStatus{Status: "running", WorkDir: workDir}, false},
		{"shared with active task", &TaskGCStatus{Status: "cancelled", WorkDir: workDir, ActiveReferences: 1}, false},
		{"different path", &TaskGCStatus{Status: "failed", WorkDir: workDir + "-other"}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := taskWorkdirReclaimable(tt.task, workDir); got != tt.want {
				t.Fatalf("taskWorkdirReclaimable() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestGitWorktreeIsCleanAllowsManagedRootWithoutCheckout(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "AGENTS.md"), []byte("managed\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !gitWorktreeIsClean(root) {
		t.Fatal("managed workdir without a checkout should be reclaimable")
	}
}

func TestRetainTaskWorkspace(t *testing.T) {
	t.Setenv("MULTICA_WORKSPACE_RETAIN", "1")
	if !retainTaskWorkspace() {
		t.Fatal("MULTICA_WORKSPACE_RETAIN=1 must disable terminal cleanup")
	}
}

func TestRemoveTerminalTaskArtifactsKeepsLogsAndMetadata(t *testing.T) {
	root := t.TempDir()
	for _, rel := range []string{"workdir/repo/file", "codex-home/session", "multica-config/config", "logs/task.log", ".gc_meta.json"} {
		path := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("data"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	var output bytes.Buffer
	removeTerminalTaskArtifacts(root, slog.New(slog.NewTextHandler(&output, nil)))
	for _, rel := range []string{"workdir", "codex-home", "multica-config"} {
		if _, err := os.Stat(filepath.Join(root, rel)); !os.IsNotExist(err) {
			t.Fatalf("%s still exists after cleanup", rel)
		}
	}
	for _, rel := range []string{"logs/task.log", ".gc_meta.json"} {
		if _, err := os.Stat(filepath.Join(root, rel)); err != nil {
			t.Fatalf("preserved artifact %s: %v", rel, err)
		}
	}
	if got := strings.Count(output.String(), "terminal task artifact deleted"); got != 3 {
		t.Fatalf("deletion log count = %d, want 3; output=%q", got, output.String())
	}
	if !strings.Contains(output.String(), "bytes=4") {
		t.Fatalf("deletion log missing byte count: %q", output.String())
	}
}
