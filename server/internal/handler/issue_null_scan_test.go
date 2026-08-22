package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Historical imports may lack creator_type and number. Both list surfaces must
// return the row rather than failing the whole response during pgx scanning.
func TestIssueListsTolerateNullCreatorTypeAndNumber(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	ctx := context.Background()
	var issueID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO issue (workspace_id, title, status, priority, creator_type, number)
		VALUES ($1, 'null scan regression row', 'todo', 'none', NULL, NULL)
		RETURNING id
	`, testWorkspaceID).Scan(&issueID); err != nil {
		t.Fatalf("insert NULL regression row: %v", err)
	}
	t.Cleanup(func() { _, _ = testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1`, issueID) })

	list := httptest.NewRecorder()
	testHandler.ListIssues(list, newRequest(http.MethodGet, "/api/issues?workspace_id="+testWorkspaceID, nil))
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), "null scan regression row") {
		t.Fatalf("ListIssues = %d: %s", list.Code, list.Body.String())
	}

	table := httptest.NewRecorder()
	testHandler.ListIssueTableRows(table, newRequest(http.MethodPost, "/api/issues/table/rows?workspace_id="+testWorkspaceID, map[string]any{
		"query": map[string]any{"scope": map[string]any{"kind": "workspace"}, "filters": map[string]any{}, "sort": map[string]any{"field": "created_at", "direction": "desc"}},
		"group": map[string]any{"kind": "none"}, "hierarchy": map[string]any{"enabled": false}, "page": map[string]any{"limit": 100},
	}))
	if table.Code != http.StatusOK || !strings.Contains(table.Body.String(), "null scan regression row") {
		t.Fatalf("ListIssueTableRows = %d: %s", table.Code, table.Body.String())
	}
}
