package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func decodeOperatorResponse(t *testing.T, rr *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return body
}

func TestListWorkspaceOperatorAgents(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("no test database")
	}
	name := "operator-roster-agent"
	agentID := createHandlerTestAgent(t, name, nil)
	t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM agent WHERE id = $1`, agentID) })

	req := newRequest("GET", "/api/operator/workspaces/{workspaceId}/agents/", nil)
	req = withURLParam(req, "workspaceId", testWorkspaceID)
	rr := httptest.NewRecorder()
	testHandler.ListWorkspaceOperatorAgents(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rr.Code, rr.Body.String())
	}
	body := decodeOperatorResponse(t, rr)
	count, ok := body["count"].(float64)
	if !ok || int(count) < 1 {
		t.Fatalf("count missing/zero in list response: %v", body)
	}
	agents, ok := body["agents"].([]any)
	if !ok {
		t.Fatalf("agents missing: %v", body)
	}
	var found bool
	for _, a := range agents {
		m := a.(map[string]any)
		if m["name"] == name && m["id"] == agentID {
			found = true
			// Operator roster must never serialize secrets.
			if _, hasEnv := m["custom_env"]; hasEnv {
				t.Fatalf("operator roster leaked custom_env")
			}
			if _, hasMcp := m["mcp_config"]; hasMcp {
				t.Fatalf("operator roster leaked mcp_config")
			}
		}
	}
	if !found {
		t.Fatalf("created agent %s not found in operator list", agentID)
	}
}

func TestGetWorkspaceOperatorAgentByUUIDAndName(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("no test database")
	}
	name := "operator-get-agent"
	agentID := createHandlerTestAgent(t, name, nil)
	t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM agent WHERE id = $1`, agentID) })

	// Resolve by UUID.
	req := newRequest("GET", "/api/operator/workspaces/{workspaceId}/agents/{ref}", nil)
	req = withURLParams(req, "workspaceId", testWorkspaceID, "ref", agentID)
	rr := httptest.NewRecorder()
	testHandler.GetWorkspaceOperatorAgent(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("by-uuid status = %d, want 200 (body %s)", rr.Code, rr.Body.String())
	}
	body := decodeOperatorResponse(t, rr)
	if body["id"] != agentID || body["name"] != name {
		t.Fatalf("unexpected by-uuid agent: %v", body)
	}

	// Resolve by exact name.
	req = newRequest("GET", "/api/operator/workspaces/{workspaceId}/agents/{ref}", nil)
	req = withURLParams(req, "workspaceId", testWorkspaceID, "ref", name)
	rr = httptest.NewRecorder()
	testHandler.GetWorkspaceOperatorAgent(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("by-name status = %d, want 200 (body %s)", rr.Code, rr.Body.String())
	}
	body = decodeOperatorResponse(t, rr)
	if body["id"] != agentID {
		t.Fatalf("by-name agent id = %v, want %s", body["id"], agentID)
	}

	// Cross-workspace / unknown reference -> 404 and no mutation.
	req = newRequest("GET", "/api/operator/workspaces/{workspaceId}/agents/{ref}", nil)
	req = withURLParams(req, "workspaceId", testWorkspaceID, "ref", "does-not-exist-anywhere")
	rr = httptest.NewRecorder()
	testHandler.GetWorkspaceOperatorAgent(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("missing-by-name status = %d, want 404", rr.Code)
	}
}

func TestUpdateWorkspaceOperatorAgentRejectsUnknownField(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("no test database")
	}
	agentID := createHandlerTestAgent(t, "operator-update-badfield", nil)
	t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM agent WHERE id = $1`, agentID) })

	req := newRequest("PATCH", "/api/operator/workspaces/{workspaceId}/agents/{ref}", map[string]any{
		"instructions": "not-allowed",
	})
	req = withURLParams(req, "workspaceId", testWorkspaceID, "ref", agentID)
	rr := httptest.NewRecorder()
	testHandler.UpdateWorkspaceOperatorAgent(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("unknown-field status = %d, want 400 (body %s)", rr.Code, rr.Body.String())
	}
}

func TestUpdateWorkspaceOperatorAgentMaxConcurrent(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("no test database")
	}
	agentID := createHandlerTestAgent(t, "operator-update-maxconc", nil)
	t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM agent WHERE id = $1`, agentID) })

	req := newRequest("PATCH", "/api/operator/workspaces/{workspaceId}/agents/{ref}", map[string]any{
		"max_concurrent_tasks": 12,
	})
	req = withURLParams(req, "workspaceId", testWorkspaceID, "ref", agentID)
	rr := httptest.NewRecorder()
	testHandler.UpdateWorkspaceOperatorAgent(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rr.Code, rr.Body.String())
	}
	body := decodeOperatorResponse(t, rr)
	if body["max_concurrent_tasks"] != float64(12) {
		t.Fatalf("max_concurrent_tasks = %v, want 12", body["max_concurrent_tasks"])
	}

	// Invalid value -> 400 and no mutation.
	req = newRequest("PATCH", "/api/operator/workspaces/{workspaceId}/agents/{ref}", map[string]any{
		"max_concurrent_tasks": 99999,
	})
	req = withURLParams(req, "workspaceId", testWorkspaceID, "ref", agentID)
	rr = httptest.NewRecorder()
	testHandler.UpdateWorkspaceOperatorAgent(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("invalid-value status = %d, want 400", rr.Code)
	}
}

func TestUpdateWorkspaceOperatorAgentValidationIsAtomic(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("no test database")
	}
	agentID := createHandlerTestAgent(t, "operator-update-atomic", nil)
	t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM agent WHERE id = $1`, agentID) })

	// The model is valid, but the later max-concurrency value is invalid. No
	// part of the request may be persisted when validation fails.
	req := newRequest("PATCH", "/api/operator/workspaces/{workspaceId}/agents/{ref}", map[string]any{
		"model":                "would-not-persist",
		"max_concurrent_tasks": 99999,
	})
	req = withURLParams(req, "workspaceId", testWorkspaceID, "ref", agentID)
	rr := httptest.NewRecorder()
	testHandler.UpdateWorkspaceOperatorAgent(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %s)", rr.Code, rr.Body.String())
	}
	var model string
	if err := testPool.QueryRow(context.Background(), `SELECT model FROM agent WHERE id = $1`, agentID).Scan(&model); err != nil {
		t.Fatalf("read agent model: %v", err)
	}
	if model == "would-not-persist" {
		t.Fatal("valid field was persisted despite later validation failure")
	}
}

func TestUpdateWorkspaceOperatorAgentArchiveRestore(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("no test database")
	}
	agentID := createHandlerTestAgent(t, "operator-update-archive", nil)
	t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM agent WHERE id = $1`, agentID) })

	// Archive.
	req := newRequest("PATCH", "/api/operator/workspaces/{workspaceId}/agents/{ref}", map[string]any{
		"archived": true,
	})
	req = withURLParams(req, "workspaceId", testWorkspaceID, "ref", agentID)
	rr := httptest.NewRecorder()
	testHandler.UpdateWorkspaceOperatorAgent(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("archive status = %d, want 200 (body %s)", rr.Code, rr.Body.String())
	}
	var body map[string]any
	json.Unmarshal(rr.Body.Bytes(), &body)
	if body["archived_at"] == nil {
		t.Fatalf("expected archived_at to be set after archive: %v", body)
	}

	// Restore.
	req = newRequest("PATCH", "/api/operator/workspaces/{workspaceId}/agents/{ref}", map[string]any{
		"archived": false,
	})
	req = withURLParams(req, "workspaceId", testWorkspaceID, "ref", agentID)
	rr = httptest.NewRecorder()
	testHandler.UpdateWorkspaceOperatorAgent(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("restore status = %d, want 200 (body %s)", rr.Code, rr.Body.String())
	}
	body = decodeOperatorResponse(t, rr)
	if body["archived_at"] != nil {
		t.Fatalf("expected archived_at nil after restore: %v", body)
	}
}
