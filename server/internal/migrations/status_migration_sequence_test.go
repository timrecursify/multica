package migrations

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// TestIssueStatusMigrationsPreserveCanonicalData guards the live-board path:
// a board that missed 282 can still contain every canonical status before the
// 282/283/284/285 repair sequence runs.
func TestIssueStatusMigrationsPreserveCanonicalData(t *testing.T) {
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

	schema := fmt.Sprintf("issue_status_chain_%d", time.Now().UnixNano())
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
		CREATE TABLE issue (
			id UUID PRIMARY KEY,
			status TEXT NOT NULL DEFAULT 'Spec'
		);
		INSERT INTO issue (id, status) VALUES
			('00000000-0000-0000-0000-000000000001', 'Registered'),
			('00000000-0000-0000-0000-000000000002', 'Spec'),
			('00000000-0000-0000-0000-000000000003', 'Queue'),
			('00000000-0000-0000-0000-000000000004', 'In Progress'),
			('00000000-0000-0000-0000-000000000005', 'In Review'),
			('00000000-0000-0000-0000-000000000006', 'Human Review'),
			('00000000-0000-0000-0000-000000000007', 'Parked'),
			('00000000-0000-0000-0000-000000000008', 'Rejected'),
			('00000000-0000-0000-0000-000000000009', 'CI/CD & Deploy'),
			('00000000-0000-0000-0000-000000000010', 'Done'),
			('00000000-0000-0000-0000-000000000011', 'Archived'),
			('00000000-0000-0000-0000-000000000012', 'Cancelled');
	`); err != nil {
		t.Fatalf("seed canonical issue state: %v", err)
	}

	want := map[string]string{
		"00000000-0000-0000-0000-000000000001": "Registered",
		"00000000-0000-0000-0000-000000000002": "Spec",
		"00000000-0000-0000-0000-000000000003": "Queue",
		"00000000-0000-0000-0000-000000000004": "In Progress",
		"00000000-0000-0000-0000-000000000005": "In Review",
		"00000000-0000-0000-0000-000000000006": "Human Review",
		"00000000-0000-0000-0000-000000000007": "Spec",
		"00000000-0000-0000-0000-000000000008": "Spec",
		"00000000-0000-0000-0000-000000000009": "CI/CD & Deploy",
		"00000000-0000-0000-0000-000000000010": "Done",
		"00000000-0000-0000-0000-000000000011": "Archived",
		"00000000-0000-0000-0000-000000000012": "Cancelled",
	}

	for _, migration := range []string{
		"282_drop_issue_status_check_constraint.up.sql",
		"283_restore_canonical_issue_status_check.up.sql",
		"284_add_parked_rejected_issue_statuses.up.sql",
		"285_reconcile_parked_rejected_statuses.up.sql",
	} {
		applyMigrationFile(t, ctx, conn.Conn(), migration)
		assertIssueStatuses(t, ctx, conn.Conn(), want)
	}

	if _, err := conn.Exec(ctx, `
		INSERT INTO issue (id, status)
		VALUES ('00000000-0000-0000-0000-000000000013', 'unknown status')
	`); !isCheckViolation(err) {
		t.Fatalf("canonical constraint accepted unknown status: %v", err)
	}
}
