package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Production enforces non-null creator attribution and issue numbers
// (migration 274_issue_creator_type_required). NULL inserts must be rejected
// by the schema, and normal rows must still flow through both list surfaces.
func TestIssueListsEnforceNonNullCreatorTypeAndNumber(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	ctx := context.Background()
	insert := func(creatorType, number any) error {
		return testPool.QueryRow(ctx, `
			INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id, number)
			VALUES ($1, 'null contract regression row', 'todo', 'none', $2, $3, $4)
			RETURNING id
		`, testWorkspaceID, creatorType, testUserID, number).Scan(new(string))
	}

	for name, args := range map[string][]any{
		"null creator_type": {nil, 1},
		"null number":       {"member", nil},
		"both null":         {nil, nil},
	} {
		if err := insert(args[0], args[1]); err == nil {
			t.Fatalf("%s: expected NOT NULL violation", name)
		}
	}

	var issueID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id, number)
		VALUES ($1, 'null contract regression row', 'todo', 'none', 'member', $2, 1)
		RETURNING id
	`, testWorkspaceID, testUserID).Scan(&issueID); err != nil {
		t.Fatalf("insert regression row: %v", err)
	}
	t.Cleanup(func() { _, _ = testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1`, issueID) })

	list := httptest.NewRecorder()
	testHandler.ListIssues(list, newRequest(http.MethodGet, "/api/issues?workspace_id="+testWorkspaceID, nil))
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), "null contract regression row") {
		t.Fatalf("ListIssues = %d: %s", list.Code, list.Body.String())
	}

	table := httptest.NewRecorder()
	testHandler.ListIssueTableRows(table, newRequest(http.MethodPost, "/api/issues/table/rows?workspace_id="+testWorkspaceID, map[string]any{
		"query": map[string]any{"scope": map[string]any{"kind": "workspace"}, "filters": map[string]any{}, "sort": map[string]any{"field": "position", "direction": "asc"}},
		"group": map[string]any{"kind": "none"}, "hierarchy": map[string]any{"enabled": false}, "page": map[string]any{"limit": 100},
	}))
	if table.Code != http.StatusOK || !strings.Contains(table.Body.String(), "null contract regression row") {
		t.Fatalf("ListIssueTableRows = %d: %s", table.Code, table.Body.String())
	}
}
