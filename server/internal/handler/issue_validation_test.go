package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCreateIssueInvalidStatusReturns400(t *testing.T) {
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/issues?workspace_id="+testWorkspaceID, map[string]any{
		"title":  "invalid status issue",
		"status": "active",
	})
	testHandler.CreateIssue(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid status, got %d: %s", w.Code, w.Body.String())
	}
	if body := w.Body.String(); !strings.Contains(body, "backlog") {
		t.Errorf("expected error to list valid statuses, got: %s", body)
	}
}

func TestCreateIssueInvalidPriorityReturns400(t *testing.T) {
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/issues?workspace_id="+testWorkspaceID, map[string]any{
		"title":    "invalid priority issue",
		"priority": "P1",
	})
	testHandler.CreateIssue(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid priority, got %d: %s", w.Code, w.Body.String())
	}
	if body := w.Body.String(); !strings.Contains(body, "urgent") {
		t.Errorf("expected error to list valid priorities, got: %s", body)
	}
}

func TestUpdateIssueInvalidStatusReturns400(t *testing.T) {
	issueID := createTestIssue(t, "update invalid status issue", "todo", "none")
	t.Cleanup(func() { deleteTestIssue(t, issueID) })

	w := httptest.NewRecorder()
	req := newRequest("PUT", "/api/issues/"+issueID, map[string]any{"status": "active"})
	req = withURLParam(req, "id", issueID)
	testHandler.UpdateIssue(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid status, got %d: %s", w.Code, w.Body.String())
	}
}

func TestUpdateIssueInvalidPriorityReturns400(t *testing.T) {
	issueID := createTestIssue(t, "update invalid priority issue", "todo", "none")
	t.Cleanup(func() { deleteTestIssue(t, issueID) })

	w := httptest.NewRecorder()
	req := newRequest("PUT", "/api/issues/"+issueID, map[string]any{"priority": "P1"})
	req = withURLParam(req, "id", issueID)
	testHandler.UpdateIssue(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid priority, got %d: %s", w.Code, w.Body.String())
	}
}

func TestBatchUpdateIssuesInvalidStatusReturns400(t *testing.T) {
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/issues/batch-update", map[string]any{
		"issue_ids": []string{"not-needed"},
		"updates": map[string]any{
			"status": "active",
		},
	})
	testHandler.BatchUpdateIssues(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid status, got %d: %s", w.Code, w.Body.String())
	}
}

func TestBatchUpdateIssuesInvalidPriorityReturns400(t *testing.T) {
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/issues/batch-update", map[string]any{
		"issue_ids": []string{"not-needed"},
		"updates": map[string]any{
			"priority": "P1",
		},
	})
	testHandler.BatchUpdateIssues(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid priority, got %d: %s", w.Code, w.Body.String())
	}
}

func TestValidateIssueEnumAcceptsPPPWorkflowStatuses(t *testing.T) {
	for _, status := range []string{"Queue", "Spec", "Building", "QC", "In Review", "In Progress", "Human Review", "Done", "Blocked", "Cancelled", "Archived", "dead_letter", "Registered"} {
		rec := httptest.NewRecorder()
		if ok := validateIssueEnum(rec, "status", status, validIssueStatuses); !ok {
			t.Fatalf("validateIssueEnum(%q) should be accepted, body: %s", status, rec.Body.String())
		}
	}
}

func TestValidateIssueEnumStillRejectsUnknownStatus(t *testing.T) {
	rec := httptest.NewRecorder()
	if ok := validateIssueEnum(rec, "status", "BOGUSSTATUS", validIssueStatuses); ok {
		t.Fatal("validateIssueEnum(BOGUSSTATUS) should be rejected")
	}
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}
