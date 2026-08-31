package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// relayAdvanceStageFixture wires a workspace-scoped relay_stage_config edge set
// (Spec -> Queue -> In Progress -> In Review) on top of the seeded handler-test
// agent + runtime, plus a fresh issue parked in Spec. The config rows use the
// workspace-scoped path (workspace_id set), so the tests exercise the
// per-workspace isolation the migration adds, not just the global defaults.

// The seeded handler-test agent has runtime_id set and is owned by the test
// workspace user, so GetRelayStageOwner resolves a routable successor without
// fallback. cleanup removes config rows, tasks, issues, mirrors other tests.

type relayAdvanceStageFixture struct {
	IssueID   string
	AgentID   string
	RuntimeID string
}

func newRelayAdvanceStageFixture(t *testing.T) relayAdvanceStageFixture {
	t.Helper()
	ctx := context.Background()

	var agentID, runtimeID string
	if err := testPool.QueryRow(ctx, `
		SELECT a.id, a.runtime_id FROM agent a
		WHERE a.workspace_id = $1
		ORDER BY a.created_at ASC LIMIT 1
	`, testWorkspaceID).Scan(&agentID, &runtimeID); err != nil {
		t.Fatalf("load seeded agent: %v", err)
	}

	recreateStageConfig := func() {
		t.Helper()
		// Wipe workspace-scoped rows so each test starts from a clean scoped
		// edge set; global default rows are untouched.

		if _, err := testPool.Exec(ctx, `
			DELETE FROM relay_stage_config WHERE workspace_id = $1
		`, testWorkspaceID); err != nil {
			t.Fatalf("clear scoped relay config: %v", err)
		}
		var nextID int
		if err := testPool.QueryRow(ctx, `SELECT COALESCE(MAX(id), 0) + 1 FROM relay_stage_config`).Scan(&nextID); err != nil {
			t.Fatalf("next relay config id: %v", err)
		}
		insertEdge := func(stage, next, alt string) {
			t.Helper()
			altArg := interface{}(nil)
			if alt != "" {
				altArg = []string{alt}
			}
			if _, err := testPool.Exec(ctx, `
				INSERT INTO relay_stage_config (
					id, workspace_id, stage_name, next_stage, alt_next_stages, agent_id, agent_name
				) VALUES ($1, $2, $3, $4, $5, $6, $7)
			`, nextID, testWorkspaceID, stage, next, altArg, agentID, "Handler Test Agent"); err != nil {
				t.Fatalf("seed relay config %q: %v", stage, err)
			}
			nextID++
		}

		// Legal edges: Spec -> Queue; Queue -> In Progress; In Progress ->
		// In Review (alt). Each target stage also needs a config row so
		// GetRelayStageOwner resolves it; the owner agent is the seeded agent.

		insertEdge("Spec", "Queue", "")
		insertEdge("Queue", "In Progress", "")
		insertEdge("In Progress", "In Review", "")
		insertEdge("In Review", "Human Review", "")
	}
	recreateStageConfig()

	var number int
	if err := testPool.QueryRow(ctx, `
		UPDATE workspace
		SET issue_counter = GREATEST(issue_counter, (SELECT COALESCE(MAX(number), 0) FROM issue WHERE workspace_id = $1)) + 1
		WHERE id = $1 RETURNING issue_counter
	`, testWorkspaceID).Scan(&number); err != nil {
		t.Fatalf("next issue number: %v", err)
	}
	var issueID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO issue (workspace_id, creator_type, creator_id, title, status, priority, number)
		VALUES ($1, 'member', $2, $3, 'Spec', 'medium', $4)
		RETURNING id
	`, testWorkspaceID, testUserID, "relay advance-stage test", number).Scan(&issueID); err != nil {
		t.Fatalf("create issue: %v", err)
	}

	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM relay_run_log WHERE issue_id = $1`, issueID)
		testPool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE issue_id = $1`, issueID)
		testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1`, issueID)
		testPool.Exec(context.Background(), `DELETE FROM relay_stage_config WHERE workspace_id = $1`, testWorkspaceID)
	})
	return relayAdvanceStageFixture{IssueID: issueID, AgentID: agentID, RuntimeID: runtimeID}
}

func relayAdvanceHTTP(t *testing.T, issueID, toStage string) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(map[string]string{
		"issue_id": issueID,
		"to_stage": toStage,
	})
	req := httptest.NewRequest(http.MethodPost, "/api/relay/advance-stage", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	testHandler.RelayAdvanceStage(rr, req)
	return rr
}

// issueStatusOf reads an issue's status straight from the row so assertions see
// committed state.

func issueStatusOf(t *testing.T, id string) string {
	t.Helper()
	var status string
	if err := testPool.QueryRow(context.Background(), `SELECT status FROM issue WHERE id = $1`, id).Scan(&status); err != nil {
		t.Fatalf("read issue status: %v", err)
	}
	return status
}

func queuedTaskCountForIssue(t *testing.T, issueID string) int {
	t.Helper()
	var n int
	if err := testPool.QueryRow(context.Background(), `
		SELECT count(*)::int FROM agent_task_queue
		WHERE issue_id = $1 AND status = 'queued'
	`, issueID).Scan(&n); err != nil {
		t.Fatalf("count queued tasks: %v", err)
	}
	return n
}

func TestRelayAdvanceStageAdvancesAndEnqueuesOnce(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newRelayAdvanceStageFixture(t)

	rr := relayAdvanceHTTP(t, fx.IssueID, "Queue")
	if rr.Code != http.StatusOK {
		t.Fatalf("advance Spec->Queue status = %d: %s", rr.Code, rr.Body.String())
	}
	if got := issueStatusOf(t, fx.IssueID); got != "Queue" {
		t.Fatalf("issue status = %q, want Queue", got)
	}
	if got := queuedTaskCountForIssue(t, fx.IssueID); got != 1 {
		t.Fatalf("queued task count = %d, want 1", got)
	}
	var logCount int
	if err := testPool.QueryRow(context.Background(), `
		SELECT count(*)::int FROM relay_run_log WHERE issue_id = $1
	`, fx.IssueID).Scan(&logCount); err != nil {
		t.Fatalf("count relay_run_log: %v", err)
	}
	if logCount != 1 {
		t.Fatalf("relay_run_log count = %d, want 1", logCount)
	}
}

func TestRelayAdvanceStageDisallowedEdgeChangesNothing(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newRelayAdvanceStageFixture(t)

	// Jumping Spec -> In Review is not a configured successor edge.
	rr := relayAdvanceHTTP(t, fx.IssueID, "In Review")
	if rr.Code != http.StatusConflict {
		t.Fatalf("advance Spec->In Review status = %d, want 409", rr.Code)
	}
	if got := issueStatusOf(t, fx.IssueID); got != "Spec" {
		t.Fatalf("issue status = %q, want unchanged Spec", got)
	}
	if got := queuedTaskCountForIssue(t, fx.IssueID); got != 0 {
		t.Fatalf("queued task count = %d, want 0", got)
	}
}

func TestRelayAdvanceStageRejectsArchivedOwner(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newRelayAdvanceStageFixture(t)

	// Archive the successor owner so GetRelayStageOwner reports archived_at. The
	// target Queue stage points at the same seeded agent; archiving it must make
	// the transition refuse and leave everything unchanged.

	if _, err := testPool.Exec(context.Background(), `
		UPDATE agent SET archived_at = now() WHERE id = $1
	`, fx.AgentID); err != nil {
		t.Fatalf("archive agent: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `UPDATE agent SET archived_at = NULL WHERE id = $1`, fx.AgentID)
	})

	rr := relayAdvanceHTTP(t, fx.IssueID, "Queue")
	if rr.Code != http.StatusConflict {
		t.Fatalf("advance with archived owner status = %d, want 409", rr.Code)
	}
	if got := issueStatusOf(t, fx.IssueID); got != "Spec" {
		t.Fatalf("issue status = %q, want unchanged Spec", got)
	}
	if got := queuedTaskCountForIssue(t, fx.IssueID); got != 0 {
		t.Fatalf("queued task count = %d, want 0", got)
	}
}

func TestRelayAdvanceStageRepeatedDeliveryCreatesOneSuccessor(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newRelayAdvanceStageFixture(t)

	// First delivery moves the issue and enqueues a task.

	if rr := relayAdvanceHTTP(t, fx.IssueID, "Queue"); rr.Code != http.StatusOK {

		t.Fatalf("first advance status = %d: %s", rr.Code, rr.Body.String())
	}
	if rr := relayAdvanceHTTP(t, fx.IssueID, "Queue"); rr.Code != http.StatusOK {
		t.Fatalf("second (idempotent) advance status = %d: %s", rr.Code, rr.Body.String())
	}
	if got := queuedTaskCountForIssue(t, fx.IssueID); got != 1 {
		t.Fatalf("queued task count = %d, want exactly 1", got)
	}
	var logCount int
	if err := testPool.QueryRow(context.Background(), `
		SELECT count(*)::int FROM relay_run_log WHERE issue_id = $1
	`, fx.IssueID).Scan(&logCount); err != nil {
		t.Fatalf("count relay_run_log: %v", err)
	}
	// The second delivery hits "already_applied" (same status) so no second
	// log row either — idempotent end-to-end../

	if logCount != 1 {
		t.Fatalf("relay_run_log count = %d,r want 1", logCount)
	}
}

func TestRelayAdvanceStageMissingOwnerChangesNothing(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newRelayAdvanceStageFixture(t)
	if _, err := testPool.Exec(context.Background(), `DELETE FROM relay_stage_config WHERE workspace_id = $1 AND stage_name = 'Queue'`, testWorkspaceID); err != nil {
		t.Fatalf("remove target owner: %v", err)
	}
	rr := relayAdvanceHTTP(t, fx.IssueID, "Queue")
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", rr.Code, rr.Body.String())
	}
	if got := issueStatusOf(t, fx.IssueID); got != "Spec" {
		t.Fatalf("issue status = %q, want Spec", got)
	}
	if got := queuedTaskCountForIssue(t, fx.IssueID); got != 0 {
		t.Fatalf("task count = %d, want 0", got)
	}
}

func TestRelayAdvanceStageEnqueueFailureRollsBack(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newRelayAdvanceStageFixture(t)
	ctx := context.Background()
	if _, err := testPool.Exec(ctx, `CREATE OR REPLACE FUNCTION relay_test_reject_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected relay enqueue failure'; END; $$`); err != nil {
		t.Fatalf("create fault function: %v", err)
	}
	if _, err := testPool.Exec(ctx, `CREATE TRIGGER relay_test_reject_enqueue BEFORE INSERT ON agent_task_queue FOR EACH ROW WHEN (NEW.issue_id = '`+fx.IssueID+`'::uuid) EXECUTE FUNCTION relay_test_reject_enqueue()`); err != nil {
		t.Fatalf("create fault trigger: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DROP TRIGGER IF EXISTS relay_test_reject_enqueue ON agent_task_queue`)
		testPool.Exec(context.Background(), `DROP FUNCTION IF EXISTS relay_test_reject_enqueue()`)
	})
	rr := relayAdvanceHTTP(t, fx.IssueID, "Queue")
	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500: %s", rr.Code, rr.Body.String())
	}
	if got := issueStatusOf(t, fx.IssueID); got != "Spec" {
		t.Fatalf("issue status = %q, want rollback to Spec", got)
	}
	if got := queuedTaskCountForIssue(t, fx.IssueID); got != 0 {
		t.Fatalf("task count = %d, want 0", got)
	}
}

func TestRelayAdvanceStageNoRuntimeChangesNothing(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newRelayAdvanceStageFixture(t)
	ctx := context.Background()
	var oldStatus string
	if err := testPool.QueryRow(ctx, `SELECT status FROM agent_runtime WHERE id = $1`, fx.RuntimeID).Scan(&oldStatus); err != nil {
		t.Fatalf("read runtime status: %v", err)
	}
	if _, err := testPool.Exec(ctx, `UPDATE agent_runtime SET status = 'offline' WHERE id = $1`, fx.RuntimeID); err != nil {
		t.Fatalf("take runtime offline: %v", err)
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(), `UPDATE agent_runtime SET status = $2 WHERE id = $1`, fx.RuntimeID, oldStatus)
	})
	rr := relayAdvanceHTTP(t, fx.IssueID, "Queue")
	if rr.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409: %s", rr.Code, rr.Body.String())
	}
	if got := issueStatusOf(t, fx.IssueID); got != "Spec" {
		t.Fatalf("issue status = %q, want Spec", got)
	}
	if got := queuedTaskCountForIssue(t, fx.IssueID); got != 0 {
		t.Fatalf("task count = %d, want 0", got)
	}
}

func TestRelayAdvanceStageConcurrentDeliveryCreatesOneSuccessor(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	fx := newRelayAdvanceStageFixture(t)
	responses := make(chan *httptest.ResponseRecorder, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() { defer wg.Done(); responses <- relayAdvanceHTTP(t, fx.IssueID, "Queue") }()
	}
	wg.Wait()
	close(responses)
	for rr := range responses {
		if rr.Code != http.StatusOK {
			t.Fatalf("concurrent advance status = %d: %s", rr.Code, rr.Body.String())
		}
	}
	if got := queuedTaskCountForIssue(t, fx.IssueID); got != 1 {
		t.Fatalf("task count = %d, want exactly 1", got)
	}
}
