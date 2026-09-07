package daemon

import (
	"os"
	"path/filepath"
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
