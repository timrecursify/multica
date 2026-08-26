package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Event-trigger tests (PPP-21289): kind='event' autopilot triggers fire when
// an issue enters a status declared in their event_filters — native intake
// replacing the poll-based cron dispatcher. Like the webhook tests, these
// require a working DB; TestMain skips the suite when Postgres is unreachable.

func createEventTriggerViaHandler(t *testing.T, autopilotID string, filters []WebhookEventFilter) AutopilotTriggerResponse {
	t.Helper()
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/autopilots/"+autopilotID+"/triggers", map[string]any{
		"kind":          "event",
		"event_filters": filters,
	})
	req = withURLParam(req, "id", autopilotID)
	testHandler.CreateAutopilotTrigger(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateAutopilotTrigger: expected 201, got %d body=%s", w.Code, w.Body.String())
	}
	var resp AutopilotTriggerResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return resp
}

func createEventTestIssue(t *testing.T, title, status string) string {
	t.Helper()
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/issues", map[string]any{"title": title, "status": status})
	testHandler.CreateIssue(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateIssue: expected 201, got %d body=%s", w.Code, w.Body.String())
	}
	var created IssueResponse
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return created.ID
}

func updateEventTestIssueStatus(t *testing.T, issueID, status string, suppressRun bool) {
	t.Helper()
	body := map[string]any{"status": status}
	if suppressRun {
		body["suppress_run"] = true
	}
	w := httptest.NewRecorder()
	req := newRequest("PUT", "/api/issues/"+issueID, body)
	req = withURLParam(req, "id", issueID)
	testHandler.UpdateIssue(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("UpdateIssue: expected 200, got %d body=%s", w.Code, w.Body.String())
	}
}

func listEventTestRuns(t *testing.T, autopilotID string) []db.AutopilotRun {
	t.Helper()
	runs, err := testHandler.Queries.ListAutopilotRuns(context.Background(), db.ListAutopilotRunsParams{
		AutopilotID: parseUUID(autopilotID),
		Limit:       100,
		Offset:      0,
	})
	if err != nil {
		t.Fatalf("list runs: %v", err)
	}
	return runs
}

func TestCreateAutopilotTrigger_EventKindRoundTrip(t *testing.T) {
	agentID := createWebhookTestAgent(t, "EventKind Agent")
	apID := createWebhookTestAutopilot(t, agentID, "active", "run_only")

	trig := createEventTriggerViaHandler(t, apID, []WebhookEventFilter{
		{Event: "issue_status", Actions: []string{"Queue", "in_review"}},
	})
	if trig.Kind != "event" {
		t.Fatalf("expected kind=event, got %q", trig.Kind)
	}
	if len(trig.EventFilters) != 1 ||
		trig.EventFilters[0].Event != "issue_status" ||
		len(trig.EventFilters[0].Actions) != 2 {
		t.Fatalf("event_filters round-trip mismatch: %#v", trig.EventFilters)
	}

	row, err := testHandler.Queries.GetAutopilotTrigger(context.Background(), parseUUID(trig.ID))
	if err != nil {
		t.Fatalf("load stored trigger: %v", err)
	}
	if row.Kind != "event" {
		t.Fatalf("stored kind = %q, want event", row.Kind)
	}
	if len(row.EventFilters) == 0 {
		t.Fatal("stored event_filters must not be empty")
	}
}

func TestCreateAutopilotTrigger_EventKindRequiresFilters(t *testing.T) {
	agentID := createWebhookTestAgent(t, "EventNoFilter Agent")
	apID := createWebhookTestAutopilot(t, agentID, "active", "run_only")

	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/autopilots/"+apID+"/triggers", map[string]any{"kind": "event"})
	req = withURLParam(req, "id", apID)
	testHandler.CreateAutopilotTrigger(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for event trigger without filters, got %d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "event_filters is required") {
		t.Fatalf("expected event_filters-required message, got body=%s", w.Body.String())
	}
}

func TestCreateAutopilotTrigger_EventKindRejectsUnknownEvent(t *testing.T) {
	agentID := createWebhookTestAgent(t, "EventUnknown Agent")
	apID := createWebhookTestAutopilot(t, agentID, "active", "run_only")

	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/autopilots/"+apID+"/triggers", map[string]any{
		"kind": "event",
		"event_filters": []map[string]any{
			{"event": "workflow_run", "actions": []string{"completed"}},
		},
	})
	req = withURLParam(req, "id", apID)
	testHandler.CreateAutopilotTrigger(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for unknown event name, got %d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "event_filters[0].event must be") {
		t.Fatalf("expected issue_status-only message, got body=%s", w.Body.String())
	}
}

func TestAutopilotEventTrigger_FiresOnStatusEntryAndDedupes(t *testing.T) {
	agentID := createWebhookTestAgent(t, "EventFire Agent")
	apID := createWebhookTestAutopilot(t, agentID, "active", "run_only")
	createEventTriggerViaHandler(t, apID, []WebhookEventFilter{
		{Event: "issue_status", Actions: []string{"in_review"}},
	})

	// Create in todo: no watched status, no fire.
	issueID := createEventTestIssue(t, "Event trigger issue", "todo")
	if n := len(listEventTestRuns(t, apID)); n != 0 {
		t.Fatalf("create in todo must not fire, got %d runs", n)
	}

	// Entry into in_review: exactly one event run, carrying the issue.
	updateEventTestIssueStatus(t, issueID, "in_review", false)
	runs := listEventTestRuns(t, apID)
	if len(runs) != 1 {
		t.Fatalf("entry into in_review must fire once, got %d runs", len(runs))
	}
	run := runs[0]
	if run.Source != "event" {
		t.Fatalf("run source = %q, want event", run.Source)
	}
	if !strings.Contains(string(run.TriggerPayload), issueID) {
		t.Fatalf("trigger_payload must carry the triggering issue_id, got %s", run.TriggerPayload)
	}

	// Re-saving the same status (no transition) must not fire.
	updateEventTestIssueStatus(t, issueID, "in_review", false)
	if n := len(listEventTestRuns(t, apID)); n != 1 {
		t.Fatalf("same-status re-save must not fire, got %d runs", n)
	}

	// Leave and re-enter inside the dedupe window must not double-fire.
	updateEventTestIssueStatus(t, issueID, "todo", false)
	updateEventTestIssueStatus(t, issueID, "in_review", false)
	if n := len(listEventTestRuns(t, apID)); n != 1 {
		t.Fatalf("dedupe window must collapse retries, got %d runs", n)
	}
}

func TestAutopilotEventTrigger_SuppressRunSkipsFire(t *testing.T) {
	agentID := createWebhookTestAgent(t, "EventSuppress Agent")
	apID := createWebhookTestAutopilot(t, agentID, "active", "run_only")
	createEventTriggerViaHandler(t, apID, []WebhookEventFilter{
		{Event: "issue_status", Actions: []string{"in_review"}},
	})

	issueID := createEventTestIssue(t, "Event suppress issue", "todo")
	updateEventTestIssueStatus(t, issueID, "in_review", true)
	if n := len(listEventTestRuns(t, apID)); n != 0 {
		t.Fatalf("suppress_run must skip the event fire, got %d runs", n)
	}
}

func TestAutopilotEventTrigger_FiresOnCreateInWatchedStatus(t *testing.T) {
	agentID := createWebhookTestAgent(t, "EventCreate Agent")
	apID := createWebhookTestAutopilot(t, agentID, "active", "run_only")
	createEventTriggerViaHandler(t, apID, []WebhookEventFilter{
		{Event: "issue_status", Actions: []string{"in_review"}},
	})

	// An issue CREATED directly in a watched status is an entry into that
	// status — the cron dispatcher would have picked it up on its next poll.
	createEventTestIssue(t, "Created in review", "in_review")
	if n := len(listEventTestRuns(t, apID)); n != 1 {
		t.Fatalf("create in watched status must fire once, got %d runs", n)
	}
}

func TestAutopilotEventTrigger_IgnoresOtherStatuses(t *testing.T) {
	agentID := createWebhookTestAgent(t, "EventOther Agent")
	apID := createWebhookTestAutopilot(t, agentID, "active", "run_only")
	createEventTriggerViaHandler(t, apID, []WebhookEventFilter{
		{Event: "issue_status", Actions: []string{"in_review"}},
	})

	issueID := createEventTestIssue(t, "Event other issue", "todo")
	updateEventTestIssueStatus(t, issueID, "done", false)
	if n := len(listEventTestRuns(t, apID)); n != 0 {
		t.Fatalf("transition to an unwatched status must not fire, got %d runs", n)
	}
}
