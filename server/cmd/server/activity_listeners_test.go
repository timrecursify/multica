package main

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/handler"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// listActivitiesForIssue is a test helper that fetches up to 100 activity_log
// records for an issue. Uses the same query that backs the timeline endpoint.
func listActivitiesForIssue(t *testing.T, queries *db.Queries, issueID string) []db.ActivityLog {
	t.Helper()
	activities, err := queries.ListActivitiesForIssue(context.Background(), db.ListActivitiesForIssueParams{
		IssueID: util.MustParseUUID(issueID),
		Limit:   100,
	})
	if err != nil {
		t.Fatalf("ListActivitiesForIssue: %v", err)
	}
	return activities
}

func cleanupActivities(t *testing.T, issueID string) {
	t.Helper()
	testPool.Exec(context.Background(), `DELETE FROM activity_log WHERE issue_id = $1`, issueID)
}

func TestActivityIssueCreated(t *testing.T) {
	queries := db.New(testPool)
	bus := events.New()
	registerActivityListeners(bus, queries)

	issueID := createTestIssue(t, testWorkspaceID, testUserID)
	t.Cleanup(func() {
		cleanupActivities(t, issueID)
		cleanupTestIssue(t, issueID)
	})

	bus.Publish(events.Event{
		Type:        protocol.EventIssueCreated,
		WorkspaceID: testWorkspaceID,
		ActorType:   "member",
		ActorID:     testUserID,
		Payload: map[string]any{
			"issue": handler.IssueResponse{
				ID:          issueID,
				WorkspaceID: testWorkspaceID,
				Title:       "activity test issue",
				Status:      "todo",
				Priority:    "medium",
				CreatorType: "member",
				CreatorID:   testUserID,
			},
		},
	})

	activities := listActivitiesForIssue(t, queries, issueID)
	if len(activities) != 1 {
		t.Fatalf("expected 1 activity, got %d", len(activities))
	}
	if activities[0].Action != "created" {
		t.Fatalf("expected action 'created', got %q", activities[0].Action)
	}
	if util.UUIDToString(activities[0].ActorID) != testUserID {
		t.Fatalf("expected actor_id %s, got %s", testUserID, util.UUIDToString(activities[0].ActorID))
	}
}

func TestActivityIssueUpdated_StatusChanged(t *testing.T) {
	queries := db.New(testPool)
	bus := events.New()
	registerActivityListeners(bus, queries)

	issueID := createTestIssue(t, testWorkspaceID, testUserID)
	t.Cleanup(func() {
		cleanupActivities(t, issueID)
		cleanupTestIssue(t, issueID)
	})

	bus.Publish(events.Event{
		Type:        protocol.EventIssueUpdated,
		WorkspaceID: testWorkspaceID,
		ActorType:   "member",
		ActorID:     testUserID,
		Payload: map[string]any{
			"issue": handler.IssueResponse{
				ID:          issueID,
				WorkspaceID: testWorkspaceID,
				Title:       "activity test issue",
				Status:      "in_progress",
				Priority:    "medium",
				CreatorType: "member",
				CreatorID:   testUserID,
			},
			"status_changed": true,
			"prev_status":    "Spec",
		},
	})

	activities := listActivitiesForIssue(t, queries, issueID)
	if len(activities) != 1 {
		t.Fatalf("expected 1 activity, got %d", len(activities))
	}
	if activities[0].Action != "status_changed" {
		t.Fatalf("expected action 'status_changed', got %q", activities[0].Action)
	}

	var details map[string]string
	if err := json.Unmarshal(activities[0].Details, &details); err != nil {
		t.Fatalf("failed to unmarshal details: %v", err)
	}
	if details["from"] != "Spec" {
		t.Fatalf("expected from 'todo', got %q", details["from"])
	}
	if details["to"] != "in_progress" {
		t.Fatalf("expected to 'in_progress', got %q", details["to"])
	}
}

func TestActivityIssueUpdated_AssigneeChanged(t *testing.T) {
	queries := db.New(testPool)
	bus := events.New()
	registerActivityListeners(bus, queries)

	assigneeEmail := "activity-assignee-test@multica.ai"
	assigneeID := createTestUser(t, assigneeEmail)
	t.Cleanup(func() { cleanupTestUser(t, assigneeEmail) })

	issueID := createTestIssue(t, testWorkspaceID, testUserID)
	t.Cleanup(func() {
		cleanupActivities(t, issueID)
		cleanupTestIssue(t, issueID)
	})

	assigneeType := "member"
	bus.Publish(events.Event{
		Type:        protocol.EventIssueUpdated,
		WorkspaceID: testWorkspaceID,
		ActorType:   "member",
		ActorID:     testUserID,
		Payload: map[string]any{
			"issue": handler.IssueResponse{
				ID:           issueID,
				WorkspaceID:  testWorkspaceID,
				Title:        "activity test issue",
				Status:       "todo",
				Priority:     "medium",
				CreatorType:  "member",
				CreatorID:    testUserID,
				AssigneeType: &assigneeType,
				AssigneeID:   &assigneeID,
			},
			"assignee_changed":   true,
			"prev_assignee_type": (*string)(nil),
			"prev_assignee_id":   (*string)(nil),
		},
	})

	activities := listActivitiesForIssue(t, queries, issueID)
	if len(activities) != 1 {
		t.Fatalf("expected 1 activity, got %d", len(activities))
	}
	if activities[0].Action != "assignee_changed" {
		t.Fatalf("expected action 'assignee_changed', got %q", activities[0].Action)
	}

	var details map[string]string
	if err := json.Unmarshal(activities[0].Details, &details); err != nil {
		t.Fatalf("failed to unmarshal details: %v", err)
	}
	if details["to_type"] != "member" {
		t.Fatalf("expected to_type 'member', got %q", details["to_type"])
	}
	if details["to_id"] != assigneeID {
		t.Fatalf("expected to_id %q, got %q", assigneeID, details["to_id"])
	}
}

func TestIssueFunnelTransitionsRecordDeliveryStages(t *testing.T) {
	issueID := createTestIssue(t, testWorkspaceID, testUserID)
	t.Cleanup(func() { cleanupTestIssue(t, issueID) })

	assigneeID := createTestUser(t, "funnel-assignee-test@multica.ai")
	t.Cleanup(func() { cleanupTestUser(t, "funnel-assignee-test@multica.ai") })
	ctx := context.Background()
	if _, err := testPool.Exec(ctx, `UPDATE issue SET assignee_type = 'member', assignee_id = $2, status = 'in_progress' WHERE id = $1`, issueID, assigneeID); err != nil {
		t.Fatalf("assign and start issue: %v", err)
	}
	if _, err := testPool.Exec(ctx, `UPDATE issue SET status = 'in_review' WHERE id = $1`, issueID); err != nil {
		t.Fatalf("send issue to review: %v", err)
	}
	if _, err := testPool.Exec(ctx, `UPDATE issue SET status = 'Done' WHERE id = $1`, issueID); err != nil {
		t.Fatalf("complete issue: %v", err)
	}

	rows, err := testPool.Query(ctx, `SELECT stage FROM issue_funnel_stage_duration WHERE issue_id = $1 ORDER BY transition_sequence`, issueID)
	if err != nil {
		t.Fatalf("query funnel durations: %v", err)
	}
	defer rows.Close()
	var stages []string
	for rows.Next() {
		var stage string
		if err := rows.Scan(&stage); err != nil {
			t.Fatalf("scan stage: %v", err)
		}
		stages = append(stages, stage)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate stages: %v", err)
	}
	want := []string{"created", "assigned", "in_progress", "review", "done"}
	if len(stages) != len(want) {
		t.Fatalf("stage count = %d, want %d (%v)", len(stages), len(want), stages)
	}
	for i, stage := range want {
		if stages[i] != stage {
			t.Fatalf("stage[%d] = %q, want %q", i, stages[i], stage)
		}
	}
}

func TestActivityIssueUpdated_NoChangeFlags(t *testing.T) {
	queries := db.New(testPool)
	bus := events.New()
	registerActivityListeners(bus, queries)

	issueID := createTestIssue(t, testWorkspaceID, testUserID)
	t.Cleanup(func() {
		cleanupActivities(t, issueID)
		cleanupTestIssue(t, issueID)
	})

	// Publish issue:updated with no change flags set
	bus.Publish(events.Event{
		Type:        protocol.EventIssueUpdated,
		WorkspaceID: testWorkspaceID,
		ActorType:   "member",
		ActorID:     testUserID,
		Payload: map[string]any{
			"issue": handler.IssueResponse{
				ID:          issueID,
				WorkspaceID: testWorkspaceID,
				Title:       "activity test issue",
				Status:      "todo",
				Priority:    "medium",
				CreatorType: "member",
				CreatorID:   testUserID,
			},
			"assignee_changed":    false,
			"status_changed":      false,
			"description_changed": false,
		},
	})

	activities := listActivitiesForIssue(t, queries, issueID)
	if len(activities) != 0 {
		t.Fatalf("expected 0 activities when no change flags, got %d", len(activities))
	}
}

func TestActivityIssueUpdated_TitleChanged(t *testing.T) {
	queries := db.New(testPool)
	bus := events.New()
	registerActivityListeners(bus, queries)

	issueID := createTestIssue(t, testWorkspaceID, testUserID)
	t.Cleanup(func() {
		cleanupActivities(t, issueID)
		cleanupTestIssue(t, issueID)
	})

	bus.Publish(events.Event{
		Type:        protocol.EventIssueUpdated,
		WorkspaceID: testWorkspaceID,
		ActorType:   "member",
		ActorID:     testUserID,
		Payload: map[string]any{
			"issue": handler.IssueResponse{
				ID:          issueID,
				WorkspaceID: testWorkspaceID,
				Title:       "renamed issue",
				Status:      "todo",
				Priority:    "medium",
				CreatorType: "member",
				CreatorID:   testUserID,
			},
			"title_changed": true,
			"prev_title":    "activity test issue",
		},
	})

	activities := listActivitiesForIssue(t, queries, issueID)
	if len(activities) != 1 {
		t.Fatalf("expected 1 activity, got %d", len(activities))
	}
	if activities[0].Action != "title_changed" {
		t.Fatalf("expected action 'title_changed', got %q", activities[0].Action)
	}

	var details map[string]string
	if err := json.Unmarshal(activities[0].Details, &details); err != nil {
		t.Fatalf("failed to unmarshal details: %v", err)
	}
	if details["from"] != "activity test issue" {
		t.Fatalf("expected from 'activity test issue', got %q", details["from"])
	}
	if details["to"] != "renamed issue" {
		t.Fatalf("expected to 'renamed issue', got %q", details["to"])
	}
}

func TestActivityTaskCompleted(t *testing.T) {
	queries := db.New(testPool)
	bus := events.New()
	registerActivityListeners(bus, queries)

	issueID := createTestIssue(t, testWorkspaceID, testUserID)
	t.Cleanup(func() {
		cleanupActivities(t, issueID)
		cleanupTestIssue(t, issueID)
	})

	agentID := testUserID // reuse as a stand-in for agent ID

	bus.Publish(events.Event{
		Type:        protocol.EventTaskCompleted,
		WorkspaceID: testWorkspaceID,
		ActorType:   "system",
		ActorID:     "",
		Payload: map[string]any{
			"task_id":  "00000000-0000-0000-0000-000000000001",
			"agent_id": agentID,
			"issue_id": issueID,
			"status":   "completed",
		},
	})

	activities := listActivitiesForIssue(t, queries, issueID)
	if len(activities) != 1 {
		t.Fatalf("expected 1 activity, got %d", len(activities))
	}
	if activities[0].Action != "task_completed" {
		t.Fatalf("expected action 'task_completed', got %q", activities[0].Action)
	}
	if util.UUIDToString(activities[0].ActorID) != agentID {
		t.Fatalf("expected actor_id %s, got %s", agentID, util.UUIDToString(activities[0].ActorID))
	}
}

func TestActivityTaskFailed(t *testing.T) {
	queries := db.New(testPool)
	bus := events.New()
	registerActivityListeners(bus, queries)

	issueID := createTestIssue(t, testWorkspaceID, testUserID)
	t.Cleanup(func() {
		cleanupActivities(t, issueID)
		cleanupTestIssue(t, issueID)
	})

	agentID := testUserID

	bus.Publish(events.Event{
		Type:        protocol.EventTaskFailed,
		WorkspaceID: testWorkspaceID,
		ActorType:   "system",
		ActorID:     "",
		Payload: map[string]any{
			"task_id":  "00000000-0000-0000-0000-000000000002",
			"agent_id": agentID,
			"issue_id": issueID,
			"status":   "failed",
		},
	})

	activities := listActivitiesForIssue(t, queries, issueID)
	if len(activities) != 1 {
		t.Fatalf("expected 1 activity, got %d", len(activities))
	}
	if activities[0].Action != "task_failed" {
		t.Fatalf("expected action 'task_failed', got %q", activities[0].Action)
	}
}
