package daemon

import (
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/multica-ai/multica/server/internal/daemon/execenv"
)

func TestCleanupCompletedTaskEnvRemovesManagedRoots(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	for _, outcome := range []string{"completed", "failed", "cancelled"} {
		t.Run(outcome, func(t *testing.T) {
			root := t.TempDir()
			if err := execenv.WriteManagedEnvProvenance(root, execenv.ManagedEnvProvenance{WorkspaceID: "ws", TaskID: outcome}); err != nil { t.Fatal(err) }
			if err := os.WriteFile(filepath.Join(root, "payload"), []byte("x"), 0o600); err != nil { t.Fatal(err) }
			d := &Daemon{}
			d.cleanupCompletedTaskEnv(Task{ID: outcome, WorkspaceID: "ws"}, root, logger)
			if _, err := os.Stat(root); !os.IsNotExist(err) { t.Fatalf("managed root remains: %v", err) }
		})
	}
}

func TestCleanupCompletedTaskEnvPreservesProtectedRoots(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	 t.Run("active", func(t *testing.T) {
		root := t.TempDir(); d := &Daemon{}
		if err := execenv.WriteManagedEnvProvenance(root, execenv.ManagedEnvProvenance{WorkspaceID: "ws", TaskID: "t"}); err != nil { t.Fatal(err) }
		d.markActiveEnvRoot(root); defer d.unmarkActiveEnvRoot(root)
		d.cleanupCompletedTaskEnv(Task{ID: "t", WorkspaceID: "ws"}, root, logger)
		if _, err := os.Stat(root); err != nil { t.Fatalf("active root removed: %v", err) }
	})
	t.Run("unprovenanced", func(t *testing.T) {
		root := t.TempDir(); d := &Daemon{}
		d.cleanupCompletedTaskEnv(Task{ID: "t", WorkspaceID: "ws"}, root, logger)
		if _, err := os.Stat(root); err != nil { t.Fatalf("unprovenanced root removed: %v", err) }
	})
	t.Run("local_directory", func(t *testing.T) {
		root := t.TempDir(); d := &Daemon{cfg: Config{DaemonID: "daemon"}}
		if err := execenv.WriteManagedEnvProvenance(root, execenv.ManagedEnvProvenance{WorkspaceID: "ws", TaskID: "t"}); err != nil { t.Fatal(err) }
		ref, _ := json.Marshal(map[string]string{"local_path": root, "daemon_id": "daemon"})
		task := Task{ID: "t", WorkspaceID: "ws", ProjectResources: []ProjectResourceData{{ResourceType: "local_directory", ResourceRef: ref}}}
		d.cleanupCompletedTaskEnv(task, root, logger)
		if _, err := os.Stat(root); err != nil { t.Fatalf("local_directory root removed: %v", err) }
	})
}
