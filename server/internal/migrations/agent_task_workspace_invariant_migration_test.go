package migrations

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Exercises the invariant in a rolled-back PostgreSQL transaction. The test is
// intentionally skipped in unit-only environments without DATABASE_URL.
func TestAgentTaskWorkspaceInvariantMigration(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("integration test requires Postgres at DATABASE_URL")
	}
	ctx := context.Background()
	p, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	c, err := p.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Release()
	tx, err := c.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	for _, ddl := range []string{
		`CREATE TEMP TABLE workspace(id uuid PRIMARY KEY)`,
		`CREATE TEMP TABLE agent(id uuid PRIMARY KEY, workspace_id uuid)`,
		`CREATE TEMP TABLE agent_runtime(id uuid PRIMARY KEY, workspace_id uuid)`,
		`CREATE TEMP TABLE issue(id uuid PRIMARY KEY, workspace_id uuid)`,
		`CREATE TEMP TABLE chat_session(id uuid PRIMARY KEY, workspace_id uuid)`,
		`CREATE TEMP TABLE autopilot(id uuid PRIMARY KEY, workspace_id uuid)`,
		`CREATE TEMP TABLE autopilot_run(id uuid PRIMARY KEY, autopilot_id uuid)`,
		`CREATE TEMP TABLE agent_task_queue(id uuid PRIMARY KEY, agent_id uuid, runtime_id uuid, issue_id uuid, chat_session_id uuid, autopilot_run_id uuid, workspace_id uuid, status text, completed_at timestamptz, error text, failure_reason text, prepare_lease_expires_at timestamptz)`,
	} {
		if _, err := tx.Exec(ctx, ddl); err != nil {
			t.Fatal(err)
		}
	}
	applyMigrationFile(t, ctx, tx.Conn(), "304_agent_task_workspace_invariant.up.sql")
	wsA, wsB := "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"
	if _, err := tx.Exec(ctx, `INSERT INTO workspace VALUES ($1),($2); INSERT INTO agent VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',$1); INSERT INTO agent_runtime VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',$2)`, wsA, wsB); err != nil {
		t.Fatal(err)
	}
	_, err = tx.Exec(ctx, `INSERT INTO agent_task_queue(id,agent_id,runtime_id,status) VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','queued')`)
	if err == nil {
		t.Fatal("expected runtime workspace mismatch to be rejected")
	}
}
