package migrations

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestIssueStatusContractCompatibilityMigrationIsIdempotent(t *testing.T) {
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

	schema := fmt.Sprintf("issue_status_285_%d", time.Now().UnixNano())
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
			('00000000-0000-0000-0000-000000000002', 'In Progress'),
			('00000000-0000-0000-0000-000000000003', 'In Review'),
			('00000000-0000-0000-0000-000000000004', 'CI/CD & Deploy');
		ALTER TABLE issue ADD CONSTRAINT issue_status_check CHECK (status IN
			('Registered', 'Spec', 'Queue', 'In Progress', 'In Review',
			 'Human Review', 'CI/CD & Deploy', 'Done', 'Archived', 'Cancelled'));
	`); err != nil {
		t.Fatalf("seed scratch issue table: %v", err)
	}

	applyMigrationFile(t, ctx, conn.Conn(), "285_issue_status_contract_compatibility.up.sql")
	// Running the SQL a second time must not fail or duplicate the trigger.
	applyMigrationFile(t, ctx, conn.Conn(), "285_issue_status_contract_compatibility.up.sql")

	rows := []struct {
		id, input, want string
	}{
		{"00000000-0000-0000-0000-000000000005", "todo", "Spec"},
		{"00000000-0000-0000-0000-000000000006", "in_progress", "in_progress"},
		{"00000000-0000-0000-0000-000000000007", "in_review", "in_review"},
		{"00000000-0000-0000-0000-000000000008", "CI/CD & Deploy", "CI/CD & Deploy"},
	}
	for _, row := range rows {
		if _, err := conn.Exec(ctx, "INSERT INTO issue (id, status) VALUES ($1, $2)", row.id, row.input); err != nil {
			t.Fatalf("insert %q: %v", row.input, err)
		}
		var got string
		if err := conn.QueryRow(ctx, "SELECT status FROM issue WHERE id = $1", row.id).Scan(&got); err != nil {
			t.Fatalf("read %q: %v", row.input, err)
		}
		if got != row.want {
			t.Errorf("status %q = %q, want %q", row.input, got, row.want)
		}
	}

	var triggerCount int
	if err := conn.QueryRow(ctx, `SELECT count(*) FROM pg_trigger
		WHERE tgrelid = 'issue'::regclass AND tgname = 'issue_status_normalize_before_write'`).Scan(&triggerCount); err != nil {
		t.Fatalf("count status triggers: %v", err)
	}
	if triggerCount != 1 {
		t.Fatalf("status trigger count = %d, want 1", triggerCount)
	}
}
