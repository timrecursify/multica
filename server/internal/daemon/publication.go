package daemon

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// PublicationReceipt is evidence that a task's implementation commit is
// reachable from the repository's canonical origin.
type PublicationReceipt struct {
	RepositoryURL string `json:"repository_url"`
	SHA           string `json:"implementation_sha"`
	RemoteRef     string `json:"remote_ref"`
}

// verifyGitPublication performs a fresh readback from origin. Cached
// remote-tracking refs are intentionally not consulted.
func verifyGitPublication(workDir string) (*PublicationReceipt, error) {
	if workDir == "" || !isGitWorktree(workDir) {
		return nil, nil
	}
	sha, err := runGitGCCommand(workDir, "rev-parse", "HEAD")
	if err != nil {
		return nil, fmt.Errorf("resolve implementation HEAD: %w", err)
	}
	sha = strings.TrimSpace(sha)
	origin, err := runGitGCCommand(workDir, "config", "--get", "remote.origin.url")
	if err != nil || strings.TrimSpace(origin) == "" {
		return nil, fmt.Errorf("canonical origin is not configured")
	}
	origin = strings.TrimSpace(origin)
	refs, err := runGitGCCommand(workDir, "ls-remote", origin, "refs/heads/*", "refs/pull/*/head")
	if err != nil {
		return nil, fmt.Errorf("origin readback: %w", err)
	}
	for _, line := range strings.Split(refs, "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[0] == sha {
			return &PublicationReceipt{RepositoryURL: origin, SHA: sha, RemoteRef: fields[1]}, nil
		}
	}
	return nil, fmt.Errorf("artifact_unpublished: %s is not reachable from canonical origin", sha)
}

func isGitWorktree(workDir string) bool {
	if _, err := os.Stat(filepath.Join(workDir, ".git")); err == nil {
		return true
	}
	_, err := runGitGCCommand(workDir, "rev-parse", "--git-dir")
	return err == nil
}
