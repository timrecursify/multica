package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestSearchIssuesOversizedNumberIsTextSearch(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}

	// This is the reported value. Its request must complete successfully even
	// though it cannot be represented by PostgreSQL's integer issue.number.
	oversized := "33589389651"
	recorder := httptest.NewRecorder()
	path := fmt.Sprintf("/api/issues/search?workspace_id=%s&q=%s", testWorkspaceID, url.QueryEscape(oversized))
	testHandler.SearchIssues(recorder, newRequest(http.MethodGet, path, nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("oversized search = %d, want 200: %s", recorder.Code, recorder.Body.String())
	}

	// A normal number still takes the direct-hit path and returns its target.
	title := seedRankIssue(t, "numeric direct-hit target", "in_progress")
	var number int
	if err := testPool.QueryRow(context.Background(),
		"SELECT number FROM issue WHERE workspace_id = $1 AND title = $2", testWorkspaceID, title,
	).Scan(&number); err != nil {
		t.Fatalf("load seeded issue number: %v", err)
	}

	recorder = httptest.NewRecorder()
	path = fmt.Sprintf("/api/issues/search?workspace_id=%s&q=%d", testWorkspaceID, number)
	testHandler.SearchIssues(recorder, newRequest(http.MethodGet, path, nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("valid number search = %d, want 200: %s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		Issues []SearchIssueResponse `json:"issues"`
	}
	if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
		t.Fatalf("decode valid number search: %v", err)
	}
	if len(response.Issues) == 0 || response.Issues[0].Title != title {
		t.Fatalf("valid number search returned %+v, want direct hit %q", response.Issues, title)
	}
}
