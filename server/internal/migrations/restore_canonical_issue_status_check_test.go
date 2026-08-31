package migrations

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestRestoreCanonicalIssueStatusCheckMigrationRoundTrip(t *testing.T) {
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

	schema := fmt.Sprintf("issue_status_283_%d", time.Now().UnixNano())
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatalf("create scratch schema: %v", err)
	}
	defer func() {
		if _, err := conn.Exec(ctx, "DROP SCHEMA "+schema+" CASCADE"); err != nil {
			t.Errorf("drop scratch schema: %v", err)
		}
	}()
	if _, err := conn.Exec(ctx, "SET search_path TO "+schema); err != nil {
		t.Fatalf("select scratch schema: %v", err)
	}

	if _, err := conn.Exec(ctx, `
		CREATE TABLE issue (id UUID PRIMARY KEY, status TEXT NOT NULL DEFAULT 'Spec');
		CREATE TABLE issue_status_282_rollback (issue_id UUID PRIMARY KEY, previous_status TEXT NOT NULL);
		INSERT INTO issue (id, status) VALUES
			('00000000-0000-0000-0000-000000000001', 'Spec'),
			('00000000-0000-0000-0000-000000000002', 'Spec'),
			('00000000-0000-0000-0000-000000000003', 'in_progress'),
			('00000000-0000-0000-0000-000000000004', 'in_review'),
			('00000000-0000-0000-0000-000000000005', 'Done');
		INSERT INTO issue_status_282_rollback (issue_id, previous_status) VALUES
			('00000000-0000-0000-0000-000000000001', 'Registered'),
			('00000000-0000-0000-0000-000000000002', 'CI/CD & Deploy'),
			('00000000-0000-0000-0000-000000000003', 'In Progress'),
			('00000000-0000-0000-0000-000000000004', 'In Review'),
			('00000000-0000-0000-0000-000000000005', 'Done');
		ALTER TABLE issue ADD CONSTRAINT issue_status_check CHECK (status IN
			('Spec', 'Queue', 'in_progress', 'in_review', 'Human Review', 'Done', 'Cancelled', 'Archived'));
	`); err != nil {
		t.Fatalf("seed migration-282 state: %v", err)
	}

	applyMigrationFile(t, ctx, conn.Conn(), "283_restore_canonical_issue_status_check.up.sql")
	assertIssueStatusDefault(t, ctx, conn.Conn(), "'Spec'::text")
	assertIssueStatuses(t, ctx, conn.Conn(), map[string]string{
		"00000000-0000-0000-0000-000000000001": "Registered",
		"00000000-0000-0000-0000-000000000002": "CI/CD & Deploy",
		"00000000-0000-0000-0000-000000000003": "In Progress",
		"00000000-0000-0000-0000-000000000004": "In Review",
		"00000000-0000-0000-0000-000000000005": "Done",
	})

	if _, err := conn.Exec(ctx, `
		INSERT INTO issue (id, status) VALUES
			('00000000-0000-0000-0000-000000000006', 'Registered'),
			('00000000-0000-0000-0000-000000000007', 'CI/CD & Deploy');
	`); err != nil {
		t.Fatalf("insert restored canonical values: %v", err)
	}
	if _, err := conn.Exec(ctx, `INSERT INTO issue (id, status) VALUES ('00000000-0000-0000-0000-000000000008', 'in_progress')`); !isCheckViolation(err) {
		t.Fatalf("canonical constraint accepted legacy in_progress: %v", err)
	}

	applyMigrationFile(t, ctx, conn.Conn(), "283_restore_canonical_issue_status_check.down.sql")
	assertIssueStatuses(t, ctx, conn.Conn(), map[string]string{
		"00000000-0000-0000-0000-000000000001": "Spec",
		"00000000-0000-0000-0000-000000000002": "Spec",
		"00000000-0000-0000-0000-000000000003": "in_progress",
		"00000000-0000-0000-0000-000000000004": "in_review",
	})
	if _, err := conn.Exec(ctx, `INSERT INTO issue (id, status) VALUES ('00000000-0000-0000-0000-000000000009', 'Registered')`); !isCheckViolation(err) {
		t.Fatalf("migration-282 constraint accepted Registered: %v", err)
	}
}
