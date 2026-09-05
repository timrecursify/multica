package main

import (
	"io"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/spf13/cobra"
)

func TestRepoCheckoutTimeoutFloorAndSingleRetry(t *testing.T) {
	if got := repoCheckoutTimeout(); got < 5*time.Minute {
		t.Fatalf("checkout timeout = %s, want at least 5m", got)
	}
	attempts := 0
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		attempts++
		return nil, timeoutTestError{}
	})}
	_, err := repoCheckoutWithRetry(client, "http://checkout.invalid/repo", []byte(`{}`))
	if err == nil || !strings.Contains(err.Error(), "one retry") {
		t.Fatalf("error = %v, want exhausted checkout timeout", err)
	}
	if attempts != 2 {
		t.Fatalf("attempts = %d, want exactly 2", attempts)
	}
}

func TestRepoCheckoutRetrySucceedsOnSecondAttempt(t *testing.T) {
	attempts := 0
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		attempts++
		if attempts == 1 {
			return nil, timeoutTestError{}
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"path":"/work/repo"}`))}, nil
	})}
	resp, err := repoCheckoutWithRetry(client, "http://checkout.invalid/repo", []byte(`{}`))
	if err != nil {
		t.Fatalf("retry error = %v", err)
	}
	defer resp.Body.Close()
	if attempts != 2 {
		t.Fatalf("attempts = %d, want exactly 2", attempts)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)
func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
type timeoutTestError struct{}
func (timeoutTestError) Error() string { return "checkout timeout" }
func (timeoutTestError) Timeout() bool { return true }
func (timeoutTestError) Temporary() bool { return true }

func newRepoRegistryTestCmd(serverURL string) *cobra.Command {
	cmd := &cobra.Command{Use: "repo-test"}
	cmd.Flags().String("server-url", "", "")
	cmd.Flags().String("workspace-id", "", "")
	cmd.Flags().String("profile", "", "")
	cmd.Flags().StringArray("url", nil, "")
	cmd.Flags().String("description", "", "")
	cmd.Flags().String("output", "json", "")
	_ = cmd.Flags().Set("server-url", serverURL)
	_ = cmd.Flags().Set("workspace-id", "ws-1")
	return cmd
}

func TestRunRepoAddAppendsAndDedupes(t *testing.T) {
	initialRepos := []workspaceRepo{{URL: "https://git.example.com/web.git"}}
	var patched []workspaceRepo
	patchCount := 0

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/workspaces/ws-1":
			json.NewEncoder(w).Encode(repoWorkspaceResponse{ID: "ws-1", Repos: initialRepos})
		case r.Method == http.MethodPatch && r.URL.Path == "/api/workspaces/ws-1":
			patchCount++
			var body struct {
				Repos []workspaceRepo `json:"repos"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode patch body: %v", err)
			}
			patched = body.Repos
			json.NewEncoder(w).Encode(repoWorkspaceResponse{ID: "ws-1", Repos: body.Repos})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	cmd := newRepoRegistryTestCmd(srv.URL)
	if err := cmd.Flags().Set("url", "https://git.example.com/web.git"); err != nil {
		t.Fatal(err)
	}
	err := runRepoAdd(cmd, []string{
		"https://git.example.com/api.git",
		"https://git.example.com/api.git",
	})
	if err != nil {
		t.Fatalf("runRepoAdd: %v", err)
	}
	if patchCount != 1 {
		t.Fatalf("patchCount = %d, want 1", patchCount)
	}
	if len(patched) != 2 {
		t.Fatalf("patched repos = %+v, want 2 entries", patched)
	}
	if patched[0].URL != "https://git.example.com/web.git" || patched[1].URL != "https://git.example.com/api.git" {
		t.Fatalf("unexpected patched repos: %+v", patched)
	}
}

func TestRunRepoAddUpdatesDescriptionForExistingRepo(t *testing.T) {
	initialRepos := []workspaceRepo{{URL: "https://git.example.com/web.git", Description: "old"}}
	var patched []workspaceRepo

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/workspaces/ws-1":
			json.NewEncoder(w).Encode(repoWorkspaceResponse{ID: "ws-1", Repos: initialRepos})
		case r.Method == http.MethodPatch && r.URL.Path == "/api/workspaces/ws-1":
			var body struct {
				Repos []workspaceRepo `json:"repos"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode patch body: %v", err)
			}
			patched = body.Repos
			json.NewEncoder(w).Encode(repoWorkspaceResponse{ID: "ws-1", Repos: body.Repos})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	cmd := newRepoRegistryTestCmd(srv.URL)
	if err := cmd.Flags().Set("description", "new"); err != nil {
		t.Fatal(err)
	}
	if err := runRepoAdd(cmd, []string{"https://git.example.com/web.git"}); err != nil {
		t.Fatalf("runRepoAdd: %v", err)
	}
	if len(patched) != 1 || patched[0].Description != "new" {
		t.Fatalf("patched repos = %+v, want updated description", patched)
	}
}

func TestRunRepoAddRejectsDescriptionForMultipleRepos(t *testing.T) {
	cmd := newRepoRegistryTestCmd("http://127.0.0.1:0")
	if err := cmd.Flags().Set("description", "shared"); err != nil {
		t.Fatal(err)
	}
	err := runRepoAdd(cmd, []string{"https://git.example.com/a.git", "https://git.example.com/b.git"})
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "--description") {
		t.Fatalf("error = %q, want description guidance", err)
	}
}

func TestRunRepoRemoveDeletesExistingRepos(t *testing.T) {
	initialRepos := []workspaceRepo{
		{URL: "https://git.example.com/web.git"},
		{URL: "https://git.example.com/api.git"},
		{URL: "https://git.example.com/mobile.git"},
	}
	var patched []workspaceRepo

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/workspaces/ws-1":
			json.NewEncoder(w).Encode(repoWorkspaceResponse{ID: "ws-1", Repos: initialRepos})
		case r.Method == http.MethodPatch && r.URL.Path == "/api/workspaces/ws-1":
			var body struct {
				Repos []workspaceRepo `json:"repos"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode patch body: %v", err)
			}
			patched = body.Repos
			json.NewEncoder(w).Encode(repoWorkspaceResponse{ID: "ws-1", Repos: body.Repos})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	cmd := newRepoRegistryTestCmd(srv.URL)
	if err := cmd.Flags().Set("url", "https://git.example.com/mobile.git"); err != nil {
		t.Fatal(err)
	}
	if err := runRepoRemove(cmd, []string{"https://git.example.com/web.git"}); err != nil {
		t.Fatalf("runRepoRemove: %v", err)
	}
	if len(patched) != 1 || patched[0].URL != "https://git.example.com/api.git" {
		t.Fatalf("patched repos = %+v, want only api repo", patched)
	}
}

func TestRunRepoRemoveRejectsMissingRepoWithoutPatch(t *testing.T) {
	patchCount := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/workspaces/ws-1":
			json.NewEncoder(w).Encode(repoWorkspaceResponse{
				ID:    "ws-1",
				Repos: []workspaceRepo{{URL: "https://git.example.com/web.git"}},
			})
		case r.Method == http.MethodPatch && r.URL.Path == "/api/workspaces/ws-1":
			patchCount++
			json.NewEncoder(w).Encode(repoWorkspaceResponse{ID: "ws-1"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	cmd := newRepoRegistryTestCmd(srv.URL)
	err := runRepoRemove(cmd, []string{"https://git.example.com/missing.git"})
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Fatalf("error = %q, want not found", err)
	}
	if patchCount != 0 {
		t.Fatalf("patchCount = %d, want 0", patchCount)
	}
}

func TestRunRepoCheckoutForwardsManagedCheckoutMode(t *testing.T) {
	var body map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/repo/checkout" {
			http.NotFound(w, r)
			return
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode checkout body: %v", err)
		}
		json.NewEncoder(w).Encode(map[string]string{
			"path":        "/work/repo",
			"branch_name": "agent/test/task",
		})
	}))
	defer srv.Close()

	t.Setenv("MULTICA_DAEMON_PORT", strings.TrimPrefix(srv.URL, "http://127.0.0.1:"))
	t.Setenv("MULTICA_WORKSPACE_ID", "ws-1")
	t.Setenv("MULTICA_AGENT_NAME", "Test Agent")
	t.Setenv("MULTICA_TASK_ID", "task-1")
	t.Setenv("MULTICA_REPO_CHECKOUT_MODE", "isolated")

	previousRef := repoCheckoutRef
	repoCheckoutRef = "release/v2"
	defer func() { repoCheckoutRef = previousRef }()

	if err := runRepoCheckout(&cobra.Command{}, []string{"https://github.com/org/repo.git"}); err != nil {
		t.Fatalf("runRepoCheckout: %v", err)
	}
	if got := body["checkout_mode"]; got != "isolated" {
		t.Fatalf("checkout_mode = %q, want isolated", got)
	}
	if got := body["ref"]; got != "release/v2" {
		t.Fatalf("ref = %q, want release/v2", got)
	}
}
