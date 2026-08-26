package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// repairHandlerTaskFixture seeds an agent_task_queue row bound to the
// handler-test agent/runtime and returns its id. status and daemonID are
// caller-chosen so each test can exercise a specific CAS branch of the
// operator repair verbs (PPP-21291).
func repairHandlerTaskFixture(t *testing.T, status, daemonID string) string {
	t.Helper()
	ctx := context.Background()
	agentID := createHandlerTestAgent(t, fmt.Sprintf("repair-agent-%d", time.Now().UnixNano()), nil)

	var taskID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO agent_task_queue (agent_id, runtime_id, status, priority, context, dispatched_at, started_at, daemon_id)
		VALUES ($1, $2, $3, 0, '{}'::jsonb, now(), now(), $4)
		RETURNING id
	`, agentID, handlerTestRuntimeID(t), status, daemonID).Scan(&taskID); err != nil {
		t.Fatalf("create repair task: %v", err)
	}
	t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE id = $1`, taskID) })
	return taskID
}

func decodeRepairResponse(t *testing.T, rr *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return body
}

func TestListRepairableTasksHandler(t *testing.T) {
	taskID := repairHandlerTaskFixture(t, "running", "lane-a")

	req := newRequest("GET", "/api/operator/task-queue/", nil)
	rr := httptest.NewRecorder()
	testHandler.ListRepairableTasks(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rr.Code, rr.Body.String())
	}
	var resp struct {
		Tasks []map[string]any `json:"tasks"`
		Count int              `json:"count"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode list response: %v", err)
	}
	if resp.Count != 1 || len(resp.Tasks) != 1 {
		t.Fatalf("count = %d, tasks = %d; want 1 each", resp.Count, len(resp.Tasks))
	}
	if resp.Tasks[0]["task_id"] != taskID || resp.Tasks[0]["status"] != "running" {
		t.Fatalf("unexpected first task: %v", resp.Tasks[0])
	}
	if resp.Tasks[0]["daemon_id"] != "lane-a" {
		t.Fatalf("daemon_id = %v, want lane-a", resp.Tasks[0]["daemon_id"])
	}
}

func TestListRepairableTasksHandlerRejectsBadFilters(t *testing.T) {
	for _, path := range []string{
		"/api/operator/task-queue/?limit=0",
		"/api/operator/task-queue/?limit=501",
		"/api/operator/task-queue/?older_than=-1h",
		"/api/operator/task-queue/?older_than=banana",
		"/api/operator/task-queue/?status=bogus",
	} {
		req := newRequest("GET", path, nil)
		rr := httptest.NewRecorder()
		testHandler.ListRepairableTasks(rr, req)
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("GET %s status = %d, want 400 (body %s)", path, rr.Code, rr.Body.String())
		}
	}
}

func TestFailOrphanedTaskHandler(t *testing.T) {
	taskID := repairHandlerTaskFixture(t, "running", "")

	req := newRequest("POST", "/api/operator/task-queue/"+taskID+"/fail", map[string]string{"reason": "postgres outage orphan (PPP-21278)"})
	req = withURLParam(req, "taskId", taskID)
	rr := httptest.NewRecorder()
	testHandler.FailOrphanedTask(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rr.Code, rr.Body.String())
	}
	body := decodeRepairResponse(t, rr)
	if body["task_id"] != taskID || body["previous_status"] != "running" || body["status"] != "failed" {
		t.Fatalf("unexpected body: %v", body)
	}
	if body["replayed"] != false {
		t.Fatalf("replayed = %v, want false", body["replayed"])
	}
	if taskStatus(t, taskID) != "failed" {
		t.Fatalf("status = %s, want failed", taskStatus(t, taskID))
	}
}

func TestFailOrphanedTaskHandlerMissingReason(t *testing.T) {
	taskID := repairHandlerTaskFixture(t, "running", "")

	req := newRequest("POST", "/api/operator/task-queue/"+taskID+"/fail", map[string]string{})
	req = withURLParam(req, "taskId", taskID)
	rr := httptest.NewRecorder()
	testHandler.FailOrphanedTask(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rr.Code)
	}
	if taskStatus(t, taskID) != "running" {
		t.Fatalf("task mutated on rejected request: %s", taskStatus(t, taskID))
	}
}

func TestFailOrphanedTaskHandlerConflictOnTerminal(t *testing.T) {
	taskID := repairHandlerTaskFixture(t, "completed", "")

	req := newRequest("POST", "/api/operator/task-queue/"+taskID+"/fail", map[string]string{"reason": "should not apply"})
	req = withURLParam(req, "taskId", taskID)
	rr := httptest.NewRecorder()
	testHandler.FailOrphanedTask(rr, req)

	if rr.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (body %s)", rr.Code, rr.Body.String())
	}
}

func TestRequeueOrphanedTaskHandler(t *testing.T) {
	taskID := repairHandlerTaskFixture(t, "running", "lane-a")

	req := newRequest("POST", "/api/operator/task-queue/"+taskID+"/requeue", nil)
	req = withURLParam(req, "taskId", taskID)
	rr := httptest.NewRecorder()
	testHandler.RequeueOrphanedTask(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rr.Code, rr.Body.String())
	}
	body := decodeRepairResponse(t, rr)
	if body["task_id"] != taskID || body["previous_status"] != "running" || body["status"] != "queued" {
		t.Fatalf("unexpected body: %v", body)
	}
	if body["replayed"] != false {
		t.Fatalf("replayed = %v, want false", body["replayed"])
	}
	if taskStatus(t, taskID) != "queued" {
		t.Fatalf("status = %s, want queued", taskStatus(t, taskID))
	}
}

func TestRequeueOrphanedTaskHandlerConflictWhenQueued(t *testing.T) {
	taskID := repairHandlerTaskFixture(t, "queued", "")

	req := newRequest("POST", "/api/operator/task-queue/"+taskID+"/requeue", nil)
	req = withURLParam(req, "taskId", taskID)
	rr := httptest.NewRecorder()
	testHandler.RequeueOrphanedTask(rr, req)

	if rr.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (body %s)", rr.Code, rr.Body.String())
	}
}

func TestRepairHandlersRejectMalformedTaskID(t *testing.T) {
	for _, path := range []string{
		"/api/operator/task-queue/not-a-uuid/fail",
		"/api/operator/task-queue/not-a-uuid/requeue",
	} {
		req := newRequest("POST", path, map[string]string{"reason": "x"})
		req = withURLParam(req, "taskId", "not-a-uuid")
		rr := httptest.NewRecorder()
		testHandler.FailOrphanedTask(rr, req)
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("POST %s status = %d, want 400", path, rr.Code)
		}
	}
}
