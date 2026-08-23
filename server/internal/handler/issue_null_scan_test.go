package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Historical imports may lack priority, creator_type, and number. Both list
// surfaces must return the row rather than failing the whole response during
// pgx scanning. Description and assignee_type are already nullable pgtype.Text
// fields in the generated row, so they are exercised by this same fixture.
func TestIssueListsTolerateNullScalarFields(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	ctx := context.Background()
	var issueID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO issue (workspace_id, title, description, status, priority, assignee_type, creator_type, creator_id, number)
		VALUES ($1, 'null scan regression row', NULL, 'todo', NULL, NULL, NULL, $2, NULL)
		RETURNING id
	`, testWorkspaceID, testUserID).Scan(&issueID); err != nil {
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
		"query": map[string]any{"scope": map[string]any{"kind": "workspace"}, "filters": map[string]any{}, "sort": map[string]any{"field": "position", "direction": "asc"}},
		"group": map[string]any{"kind": "none"}, "hierarchy": map[string]any{"enabled": false}, "page": map[string]any{"limit": 100},
	}))
	if table.Code != http.StatusOK || !strings.Contains(table.Body.String(), "null scan regression row") {
		t.Fatalf("ListIssueTableRows = %d: %s", table.Code, table.Body.String())
	}
}
