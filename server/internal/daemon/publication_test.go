package daemon

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestVerifyGitPublicationRequiresCanonicalOriginReadback(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	origin := filepath.Join(root, "origin.git")
	worktree := filepath.Join(root, "work")
	run := func(dir string, args ...string) string {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
		return strings.TrimSpace(string(out))
	}
	run(root, "init", "--bare", origin)
	run(root, "clone", origin, worktree)
	run(worktree, "config", "user.email", "test@example.com")
	run(worktree, "config", "user.name", "Publication Test")
	if err := os.WriteFile(filepath.Join(worktree, "README"), []byte("initial\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(worktree, "add", "README")
	run(worktree, "commit", "-m", "initial")
	run(worktree, "push", "origin", "HEAD:refs/heads/main")

	if err := os.WriteFile(filepath.Join(worktree, "README"), []byte("unpublished\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(worktree, "commit", "-am", "unpublished")
	sha := run(worktree, "rev-parse", "HEAD")
	if receipt, err := verifyGitPublication(worktree); err == nil || receipt != nil {
		t.Fatalf("unpublished commit was accepted: receipt=%#v err=%v", receipt, err)
	}
	if gitWorktreeIsClean(worktree) {
		t.Fatal("cleanup considered unpublished commit safe")
	}

	run(worktree, "push", "origin", "HEAD:refs/heads/main")
	receipt, err := verifyGitPublication(worktree)
	if err != nil {
		t.Fatalf("published commit rejected: %v", err)
	}
	if receipt.SHA != sha || receipt.RepositoryURL != origin || receipt.RemoteRef != "refs/heads/main" {
		t.Fatalf("unexpected publication receipt: %#v", receipt)
	}
	if !gitWorktreeIsClean(worktree) {
		t.Fatal("cleanup rejected published, clean worktree")
	}
}
