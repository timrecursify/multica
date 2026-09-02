package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

// TestSearchIssues_MultiTermAggregatesCommentsOnce exercises the real handler
// and database with terms distributed between issue fields and comments. The
// short cap makes regressions to an expensive per-issue comment subplan visible
// without weakening the production three-second safety limit.
func TestSearchIssues_MultiTermAggregatesCommentsOnce(t *testing.T) {
	if testPool == nil {
		t.Skip("DATABASE_URL not set; skipping live-Postgres search test")
	}
	ctx := context.Background()
	token := fmt.Sprintf("searchmulti%d", time.Now().UnixNano())

	seed := func(title, description string) string {
		t.Helper()
		var number int
		if err := testPool.QueryRow(ctx, `
			UPDATE workspace SET issue_counter = issue_counter + 1
			WHERE id = $1 RETURNING issue_counter
		`, testWorkspaceID).Scan(&number); err != nil {
			t.Fatalf("next issue number: %v", err)
		}
		var id string
		if err := testPool.QueryRow(ctx, `
			INSERT INTO issue (workspace_id, title, description, status, priority, creator_type, creator_id, position, number)
			VALUES ($1, $2, $3, 'in_progress', 'none', 'member', $4, 0, $5) RETURNING id
		`, testWorkspaceID, title, description, testUserID, number).Scan(&id); err != nil {
			t.Fatalf("seed issue: %v", err)
		}
		t.Cleanup(func() { _, _ = testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1`, id) })
		return id
	}
	comment := func(issueID, content string) {
		t.Helper()
		if _, err := testPool.Exec(ctx, `
			INSERT INTO comment (issue_id, workspace_id, author_type, author_id, content)
			VALUES ($1, $2, 'member', $3, $4)
		`, issueID, testWorkspaceID, testUserID, content); err != nil {
			t.Fatalf("seed comment: %v", err)
		}
	}

	// The highest-ranked result has every term in its title. The second proves
	// that terms can still be satisfied across an issue field and its comments.
	topID := seed(token+" runner deploy", "")
	mixedID := seed(token+" runner", "")
	comment(mixedID, "deploy details")
	partialID := seed(token+" runner only", "")
	_ = partialID

	// A matching issue/comment in another workspace must not join into this
	// request's comment aggregate.
	var foreignWorkspaceID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO workspace (name, slug, issue_prefix)
		VALUES ($1, $2, 'FOR') RETURNING id
	`, token+" foreign", token+"-foreign").Scan(&foreignWorkspaceID); err != nil {
		t.Fatalf("seed foreign workspace: %v", err)
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(), `DELETE FROM workspace WHERE id = $1`, foreignWorkspaceID)
	})
	var foreignIssueID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id, position, number)
		VALUES ($1, $2, 'in_progress', 'none', 'member', $3, 0, 1) RETURNING id
	`, foreignWorkspaceID, token+" runner", testUserID).Scan(&foreignIssueID); err != nil {
		t.Fatalf("seed foreign issue: %v", err)
	}
	if _, err := testPool.Exec(ctx, `
		INSERT INTO comment (issue_id, workspace_id, author_type, author_id, content)
		VALUES ($1, $2, 'member', $3, 'deploy details')
	`, foreignIssueID, foreignWorkspaceID, testUserID); err != nil {
		t.Fatalf("seed foreign comment: %v", err)
	}

	oldTimeout := searchStatementTimeout
	setSearchStatementTimeoutForTest(t, 500*time.Millisecond)
	t.Cleanup(func() { setSearchStatementTimeoutForTest(t, oldTimeout) })

	path := fmt.Sprintf("/api/issues/search?workspace_id=%s&q=%s&limit=20", testWorkspaceID, url.QueryEscape(token+" runner deploy"))
	w := httptest.NewRecorder()
	testHandler.SearchIssues(w, newRequest("GET", path, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("SearchIssues: expected 200 under reduced timeout, got %d: %s", w.Code, w.Body.String())
	}
	var response struct {
		Issues []SearchIssueResponse `json:"issues"`
	}
	if err := json.NewDecoder(w.Body).Decode(&response); err != nil {
		t.Fatalf("decode search response: %v", err)
	}
	if len(response.Issues) != 2 || response.Issues[0].ID != topID || response.Issues[1].ID != mixedID {
		t.Fatalf("multi-term results = %#v, want ordered issues %s then %s only", response.Issues, topID, mixedID)
	}
}
