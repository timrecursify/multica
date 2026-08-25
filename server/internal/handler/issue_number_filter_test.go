package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Clients resolve a ticket NUMBER to a UUID. Without a server-side filter they
// page the whole board, so one poisoned page hides every ticket behind it.
func TestListIssuesNumberFilterReturnsSingleIssue(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	ctx := context.Background()
	var wantID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id, number)
		VALUES ($1, 'number filter target', 'todo', 'none', 'member', $2, 987654)
		RETURNING id
	`, testWorkspaceID, testUserID).Scan(&wantID); err != nil {
		t.Fatalf("insert numbered row: %v", err)
	}
	t.Cleanup(func() { _, _ = testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1`, wantID) })

	var otherID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id, number)
		VALUES ($1, 'number filter decoy', 'todo', 'none', 'member', $2, 987655)
		RETURNING id
	`, testWorkspaceID, testUserID).Scan(&otherID); err != nil {
		t.Fatalf("insert decoy row: %v", err)
	}
	t.Cleanup(func() { _, _ = testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1`, otherID) })

	rec := httptest.NewRecorder()
	testHandler.ListIssues(rec, newRequest(http.MethodGet, "/api/issues?workspace_id="+testWorkspaceID+"&number=987654", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("ListIssues = %d: %s", rec.Code, rec.Body.String())
	}
	var got struct {
		Issues []struct {
			ID     string `json:"id"`
			Number int32  `json:"number"`
		} `json:"issues"`
		Total int64 `json:"total"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Issues) != 1 || got.Issues[0].ID != wantID || got.Issues[0].Number != 987654 {
		t.Fatalf("number filter returned %+v, want only %s", got.Issues, wantID)
	}
	if got.Total != 1 {
		t.Fatalf("total = %d, want 1", got.Total)
	}

	// An unknown number is "not found", not an error: an empty page with 200.
	missing := httptest.NewRecorder()
	testHandler.ListIssues(missing, newRequest(http.MethodGet, "/api/issues?workspace_id="+testWorkspaceID+"&number=987000", nil))
	if missing.Code != http.StatusOK {
		t.Fatalf("unknown number = %d: %s", missing.Code, missing.Body.String())
	}

	bad := httptest.NewRecorder()
	testHandler.ListIssues(bad, newRequest(http.MethodGet, "/api/issues?workspace_id="+testWorkspaceID+"&number=abc", nil))
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("non-numeric number = %d, want 400", bad.Code)
	}
}
