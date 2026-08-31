package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// countIssuesInWorkspace returns the number of issues in the test workspace
// so a 400-with-no-mutation assertion can prove no write happened.
func countIssuesInWorkspace(t *testing.T) int {
	t.Helper()
	var n int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM issue WHERE workspace_id = $1`, testWorkspaceID,
	).Scan(&n); err != nil {
		t.Fatalf("count issues: %v", err)
	}
	return n
}

// withPPPStatusContract runs fn with the handler's contract swapped to
// the canonical PPP profile, restoring the original afterward. It is limited
// to the package-global testHandler so existing linear-profile tests stay
// hermetic.
func withPPPStatusContract(t *testing.T, fn func()) {
	t.Helper()
	orig := testHandler.IssueStatusContract
	ppp, err := NewIssueStatusContract(IssueStatusProfilePPP)
	if err != nil {
		t.Fatalf("build ppp contract: %v", err)
	}
	testHandler.IssueStatusContract = ppp
	defer func() {
		testHandler.IssueStatusContract = orig
	}()
	fn()
}

// TestCreateIssue_PPPProfileCanonicalizesLegacyInput verifies that on the PPP
// profile an ingested legacy "todo" is normalized onto the canonical "Spec"
// before persistence and returned in responses — closing the validator/storage
// contradiction where a status a client reads back cannot be written again.
func TestCreateIssue_PPPProfileCanonicalizesLegacyInput(t *testing.T) {
	withPPPStatusContract(t, func() {
		w := httptest.NewRecorder()
		req := newRequest("POST", "/api/issues?workspace_id="+testWorkspaceID, map[string]any{
			"title":  "PPP legacy todo create",
			"status": "todo",
		})
		testHandler.CreateIssue(w, req)
		if w.Code != http.StatusCreated {
			t.Fatalf("CreateIssue: expected 201, got %d: %s", w.Code, w.Body.String())
		}
		var created IssueResponse
		json.NewDecoder(w.Body).Decode(&created)
		if created.Status != "Spec" {
			t.Fatalf("CreateIssue: expected stored canonical 'Spec', got %q", created.Status)
		}
		if !testHandler.IssueStatusContract.ContainsCanonical(created.Status) {
			t.Fatalf("response status %q is not canonical for ppp profile", created.Status)
		}
		cleanupReq := newRequest("DELETE", "/api/issues/"+created.ID, nil)
		cleanupReq = withURLParam(cleanupReq, "id", created.ID)
		testHandler.DeleteIssue(httptest.NewRecorder(), cleanupReq)
	})
}

// TestCreateIssue_PPPProfileRejectsUnknownStatus verifies that on the PPP
// profile an unknown / wrong-case / whitespace-padded status fails with HTTP
// 400 and performs no write (AC5).
func TestCreateIssue_PPPProfileRejectsUnknownStatus(t *testing.T) {
	withPPPStatusContract(t, func() {
		countBefore := countIssuesInWorkspace(t)
		for _, bad := range []string{"active", "TODO", " todo", "todo ", "no-such-status"} {
			w := httptest.NewRecorder()
			req := newRequest("POST", "/api/issues?workspace_id="+testWorkspaceID, map[string]any{
				"title":  "ppp bad status " + bad,
				"status": bad,
			})
			testHandler.CreateIssue(w, req)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("CreateIssue(%q): expected 400, got %d: %s", bad, w.Code, w.Body.String())
			}
			if got := countIssuesInWorkspace(t); got != countBefore {
				t.Fatalf("status %q mutated the workspace (issues %d -> %d)", bad, countBefore, got)
			}
		}
	})
}

func TestCreateIssue_PPPProfileDefaultIsSpec(t *testing.T) {
	withPPPStatusContract(t, func() {
		w := httptest.NewRecorder()
		req := newRequest("POST", "/api/issues?workspace_id="+testWorkspaceID, map[string]any{
			"title": "ppp no-status create",
		})
		testHandler.CreateIssue(w, req)
		if w.Code != http.StatusCreated {
			t.Fatalf("CreateIssue: expected 201, got %d: %s", w.Code, w.Body.String())
		}
		var created IssueResponse
		json.NewDecoder(w.Body).Decode(&created)
		if created.Status != "Spec" {
			t.Fatalf("CreateIssue: expected ppp default 'Spec', got %q", created.Status)
		}
		if got := testHandler.IssueStatusContract.DefaultStatus(); got != "Spec" {
			t.Fatalf("DefaultStatus() = %q, want Spec", got)
		}
		cleanupReq := newRequest("DELETE", "/api/issues/"+created.ID, nil)
		cleanupReq = withURLParam(cleanupReq, "id", created.ID)
		testHandler.DeleteIssue(httptest.NewRecorder(), cleanupReq)
	})
}

func TestUpdateIssue_PPPProfileCanonicalizesStatus(t *testing.T) {
	withPPPStatusContract(t, func() {
		w := httptest.NewRecorder()
		req := newRequest("POST", "/api/issues?workspace_id="+testWorkspaceID, map[string]any{
			"title":  "ppp update canonicalize",
			"status": "Spec",
		})
		testHandler.CreateIssue(w, req)
		if w.Code != http.StatusCreated {
			t.Fatalf("create: expected 201, got %d: %s", w.Code, w.Body.String())
		}
		var created IssueResponse
		json.NewDecoder(w.Body).Decode(&created)

		// A client that read Done and writes it back must not hit a 400.
		uw := httptest.NewRecorder()
		ureq := newRequest("PATCH", "/api/issues/"+created.ID, map[string]any{
			"status": "Done",
		})
		ureq = withURLParam(ureq, "id", created.ID)
		testHandler.UpdateIssue(uw, ureq)
		if uw.Code != http.StatusOK {
			t.Fatalf("UpdateIssue(PATCH Done): expected 200, got %d: %s", uw.Code, uw.Body.String())
		}

		cleanupReq := newRequest("DELETE", "/api/issues/"+created.ID, nil)
		cleanupReq = withURLParam(cleanupReq, "id", created.ID)
		testHandler.DeleteIssue(httptest.NewRecorder(), cleanupReq)
	})
}
