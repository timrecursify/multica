package handler

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// Historical/imported rows can carry NULL creator attribution (migration
// 278_issue_creator_type_nullable). Both list surfaces must tolerate a NULL
// creator_type while creator_id and number remain NOT NULL.
func TestIssueListSurfacesTolerateNullCreatorType(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	ctx := context.Background()
	marker := fmt.Sprintf("ticket-21077-null-creator-%d", time.Now().UnixNano())
	nullTitle := marker + "-null"
	var issueID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id, number)
		VALUES ($1, $3, 'Spec', 'none', NULL, $2, 1)
		RETURNING id
	`, testWorkspaceID, testUserID, nullTitle).Scan(&issueID); err != nil {
		t.Fatalf("insert null-creator row: %v", err)
	}
	t.Cleanup(func() { _, _ = testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1`, issueID) })

	list := httptest.NewRecorder()
	testHandler.ListIssues(list, newRequest(http.MethodGet, "/api/issues?workspace_id="+testWorkspaceID, nil))
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), nullTitle) {
		t.Fatalf("ListIssues = %d: %s", list.Code, list.Body.String())
	}

	// Put a NULL attribution row behind the first page. This catches the
	// original production failure, where scanning stopped only once pagination
	// reached a historical NULL row.
	var precedingID string
	precedingTitle := marker + "-before"
	if err := testPool.QueryRow(ctx, `
		INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id, number)
		VALUES ($1, $3, 'Spec', 'none', 'member', $2, 2)
		RETURNING id
	`, testWorkspaceID, testUserID, precedingTitle).Scan(&precedingID); err != nil {
		t.Fatalf("insert preceding row: %v", err)
	}
	t.Cleanup(func() { _, _ = testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1`, precedingID) })
	window := httptest.NewRecorder()
	testHandler.ListIssues(window, newRequest(http.MethodGet,
		"/api/issues?workspace_id="+testWorkspaceID+"&q="+marker+"&sort=title&limit=1&offset=1", nil))
	if window.Code != http.StatusOK || !strings.Contains(window.Body.String(), nullTitle) {
		t.Fatalf("paginated ListIssues = %d: %s", window.Code, window.Body.String())
	}

	table := httptest.NewRecorder()
	testHandler.ListIssueTableRows(table, newRequest(http.MethodPost, "/api/issues/table/rows?workspace_id="+testWorkspaceID, map[string]any{
		"query": map[string]any{"scope": map[string]any{"kind": "workspace"}, "filters": map[string]any{}, "sort": map[string]any{"field": "position", "direction": "asc"}},
		"group": map[string]any{"kind": "none"}, "hierarchy": map[string]any{"enabled": false}, "page": map[string]any{"limit": 100},
	}))
	if table.Code != http.StatusOK || !strings.Contains(table.Body.String(), nullTitle) {
		t.Fatalf("ListIssueTableRows = %d: %s", table.Code, table.Body.String())
	}
}

// creator_id and number stay NOT NULL after 278_issue_creator_type_nullable;
// NULLs in either column must be rejected with a not-null violation (23502).
func TestIssueListsRejectNullCreatorIDAndNumber(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	ctx := context.Background()
	insert := func(creatorType, creatorID, number any) error {
		return testPool.QueryRow(ctx, `
			INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id, number)
			VALUES ($1, 'null contract regression row', 'Spec', 'none', $2, $3, $4)
			RETURNING id
		`, testWorkspaceID, creatorType, creatorID, number).Scan(new(string))
	}

	for name, args := range map[string][]any{
		"null creator_id": {"member", nil, 1},
		"null number":     {"member", testUserID, nil},
		"both null":       {nil, nil, nil},
	} {
		err := insert(args[0], args[1], args[2])
		var pgErr *pgconn.PgError
		if err == nil || !errors.As(err, &pgErr) || pgErr.Code != "23502" {
			t.Fatalf("%s: expected 23502 NOT NULL violation, got %v", name, err)
		}
	}
}
