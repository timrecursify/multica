package migrations

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// TestAgentTaskWorkspaceInvariantMigration exercises the migration against a
// scratch PostgreSQL schema so the backfill and trigger contract cannot drift
// without a database-level failure. The test is transaction-safe by dropping
// its isolated schema on completion.
func TestAgentTaskWorkspaceInvariantMigration(t *testing.T) {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		t.Skip("integration test requires Postgres at DATABASE_URL")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("connect to Postgres: %v", err)
	}
	defer pool.Close()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire Postgres connection: %v", err)
	}
	defer conn.Release()
	schema := fmt.Sprintf("agent_task_workspace_%d", time.Now().UnixNano())
	if _, err = conn.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatalf("create scratch schema: %v", err)
	}
	defer conn.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
	if _, err = conn.Exec(ctx, "SET search_path TO "+schema); err != nil {
		t.Fatalf("set search path: %v", err)
	}
	_, err = conn.Exec(ctx, `
CREATE TABLE workspace (id uuid PRIMARY KEY);
CREATE TABLE agent (id uuid PRIMARY KEY, workspace_id uuid NOT NULL);
CREATE TABLE agent_runtime (id uuid PRIMARY KEY, workspace_id uuid NOT NULL);
CREATE TABLE issue (id uuid PRIMARY KEY, workspace_id uuid NOT NULL);
CREATE TABLE chat_session (id uuid PRIMARY KEY, workspace_id uuid NOT NULL);
CREATE TABLE autopilot (id uuid PRIMARY KEY, workspace_id uuid NOT NULL);
CREATE TABLE autopilot_run (id uuid PRIMARY KEY, autopilot_id uuid NOT NULL);
CREATE TABLE agent_task_queue (
 id uuid PRIMARY KEY, agent_id uuid NOT NULL, runtime_id uuid, issue_id uuid,
 chat_session_id uuid, autopilot_run_id uuid, status text NOT NULL,
 completed_at timestamptz, error text, failure_reason text,
 prepare_lease_expires_at timestamptz
);
INSERT INTO workspace VALUES ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222');
INSERT INTO agent VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111');
INSERT INTO agent_runtime VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111');
INSERT INTO agent_runtime VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc', '22222222-2222-2222-2222-222222222222');
INSERT INTO agent_task_queue (id, agent_id, runtime_id, status)
VALUES ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'queued');
`)
	if err != nil {
		t.Fatalf("seed schema: %v", err)
	}
	applyMigrationFile(t, ctx, conn.Conn(), "304_agent_task_workspace_invariant.up.sql")

	var ws string
	if err := conn.QueryRow(ctx, `SELECT workspace_id::text FROM agent_task_queue WHERE id='dddddddd-dddd-dddd-dddd-dddddddddddd'`).Scan(&ws); err != nil {
		t.Fatalf("read backfilled workspace: %v", err)
	}
	if ws != "11111111-1111-1111-1111-111111111111" {
		t.Fatalf("workspace backfill = %s", ws)
	}
	if _, err := conn.Exec(ctx, `INSERT INTO agent_task_queue (id, agent_id, runtime_id, status, workspace_id)
VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'queued', '22222222-2222-2222-2222-222222222222')`); err == nil {
		t.Fatal("foreign task workspace was accepted")
	}
	if _, err := conn.Exec(ctx, `INSERT INTO agent_task_queue (id, agent_id, runtime_id, status)
VALUES ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'queued')`); err == nil {
		t.Fatal("foreign runtime workspace was accepted")
	}
}
