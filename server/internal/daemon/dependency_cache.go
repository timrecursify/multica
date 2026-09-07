package daemon

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

const codeReviewGraphVersion = "2.3.8"

// ensureCodeReviewGraphCache provisions the pinned graph tool once per daemon
// cache root. mkdir is used as an inter-process lock; incomplete directories
// are removed so a later task can safely retry provisioning.
func ensureCodeReviewGraphCache(root string) (string, error) {
	venv := filepath.Join(root, "code-review-graph", codeReviewGraphVersion)
	if _, err := os.Stat(filepath.Join(venv, "READY")); err == nil {
		return venv, nil
	}
	lock := venv + ".lock"
	if err := os.MkdirAll(filepath.Dir(venv), 0o755); err != nil { return "", err }
	for {
		err := os.Mkdir(lock, 0o755)
		if err == nil { break }
		if !os.IsExist(err) { return "", err }
		time.Sleep(25 * time.Millisecond)
	}
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
