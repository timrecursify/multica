package migrations

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestRestoreCanonicalIssueStatusCheckMigrationPreservesData(t *testing.T) {
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
		INSERT INTO issue (id, status) VALUES
			('00000000-0000-0000-0000-000000000001', 'Registered'),
			('00000000-0000-0000-0000-000000000002', 'Spec'),
			('00000000-0000-0000-0000-000000000003', 'Queue'),
			('00000000-0000-0000-0000-000000000004', 'In Progress'),
			('00000000-0000-0000-0000-000000000005', 'In Review'),
			('00000000-0000-0000-0000-000000000006', 'Human Review'),
			('00000000-0000-0000-0000-000000000007', 'CI/CD & Deploy'),
			('00000000-0000-0000-0000-000000000008', 'Done'),
			('00000000-0000-0000-0000-000000000009', 'Archived'),
			('00000000-0000-0000-0000-000000000010', 'Cancelled'),
			('00000000-0000-0000-0000-000000000011', 'Parked'),
			('00000000-0000-0000-0000-000000000012', 'Rejected');
	`); err != nil {
		t.Fatalf("seed canonical issue state: %v", err)
	}

	applyMigrationFile(t, ctx, conn.Conn(), "283_restore_canonical_issue_status_check.up.sql")
	assertIssueStatusDefault(t, ctx, conn.Conn(), "'Spec'::text")
	assertIssueStatuses(t, ctx, conn.Conn(), map[string]string{
		"00000000-0000-0000-0000-000000000001": "Registered",
		"00000000-0000-0000-0000-000000000002": "Spec",
		"00000000-0000-0000-0000-000000000003": "Queue",
		"00000000-0000-0000-0000-000000000004": "In Progress",
		"00000000-0000-0000-0000-000000000005": "In Review",
		"00000000-0000-0000-0000-000000000006": "Human Review",
		"00000000-0000-0000-0000-000000000007": "CI/CD & Deploy",
		"00000000-0000-0000-0000-000000000008": "Done",
		"00000000-0000-0000-0000-000000000009": "Archived",
		"00000000-0000-0000-0000-000000000010": "Cancelled",
		"00000000-0000-0000-0000-000000000011": "Parked",
		"00000000-0000-0000-0000-000000000012": "Rejected",
	})

	if _, err := conn.Exec(ctx, `INSERT INTO issue (id, status) VALUES ('00000000-0000-0000-0000-000000000013', 'in_progress')`); err != nil {
		t.Fatalf("insert legacy status through compatibility trigger: %v", err)
	}
	assertIssueStatuses(t, ctx, conn.Conn(), map[string]string{
		"00000000-0000-0000-0000-000000000013": "In Progress",
	})
	if _, err := conn.Exec(ctx, `INSERT INTO issue (id, status) VALUES ('00000000-0000-0000-0000-000000000014', 'unknown')`); !isCheckViolation(err) {
		t.Fatalf("canonical constraint accepted unknown status: %v", err)
	}
}
