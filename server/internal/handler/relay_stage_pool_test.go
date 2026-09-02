package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/multica-ai/multica/server/internal/util"
)

func TestReplaceRelayStagePoolGrantsWorkspaceInvocation(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	memberID := createPermissionTestMember(t, "relay-pool-member@multica.test")
	var agentID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO agent (workspace_id, name, description, runtime_mode, runtime_config,
			runtime_id, visibility, permission_mode, max_concurrent_tasks, owner_id)
		VALUES ($1, 'relay-pool-private-agent', '', 'cloud', '{}'::jsonb,
			$2, 'private', 'private', 1, $3) RETURNING id
	`, testWorkspaceID, handlerTestRuntimeID(t), testUserID).Scan(&agentID); err != nil {
		t.Fatalf("create private pool agent: %v", err)
	}
	t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM agent WHERE id = $1`, agentID) })

	replace := func() {
		w := httptest.NewRecorder()
		req := withURLParam(newRequest(http.MethodPut, "/api/relay-stage-pools/In%20Review", map[string]any{
			"enabled": true, "members": []string{agentID},
		}), "stage", "In Review")
		testHandler.ReplaceRelayStagePool(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("replace relay pool: expected 200, got %d: %s", w.Code, w.Body.String())
		}
	}
	replace()
	replace() // replacement is idempotent for its workspace invocation target.

	var mode string
	var targets int
	if err := testPool.QueryRow(ctx, `SELECT permission_mode FROM agent WHERE id = $1`, agentID).Scan(&mode); err != nil {
		t.Fatalf("read agent permission: %v", err)
	}
	if err := testPool.QueryRow(ctx, `SELECT count(*) FROM agent_invocation_target WHERE agent_id=$1 AND target_type='workspace' AND target_id=$2`, agentID, testWorkspaceID).Scan(&targets); err != nil {
		t.Fatalf("count workspace targets: %v", err)
	}
	if mode != "public_to" || targets != 1 {
		t.Fatalf("pool agent permission/targets = %s/%d, want public_to/1", mode, targets)
	}

	agent, err := testHandler.Queries.GetAgent(ctx, util.MustParseUUID(agentID))
	if err != nil {
		t.Fatalf("load pool agent: %v", err)
	}
	if !testHandler.canInvokeAgent(ctx, agent, "member", memberID, "", testWorkspaceID) {
		t.Error("same-workspace member cannot invoke granted pool agent")
	}
	assignment := httptest.NewRecorder()
	testHandler.CreateIssue(assignment, newRequestAs(memberID, http.MethodPost, "/api/issues?workspace_id="+testWorkspaceID, map[string]any{
		"title": "assign granted relay pool agent", "status": "todo", "assignee_type": "agent", "assignee_id": agentID,
	}))
	if assignment.Code != http.StatusCreated {
		t.Errorf("same-workspace assignment: expected 201, got %d: %s", assignment.Code, assignment.Body.String())
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE agent_id = $1`, agentID)
		testPool.Exec(context.Background(), `DELETE FROM issue WHERE workspace_id = $1 AND title = 'assign granted relay pool agent'`, testWorkspaceID)
	})
	if testHandler.canInvokeAgent(ctx, agent, "member", "99999999-9999-9999-9999-999999999999", "", testWorkspaceID) {
		t.Error("cross-workspace actor invoked granted pool agent")
	}
}
