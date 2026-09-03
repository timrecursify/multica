package migrations

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestDropIssueStatusCheckMigrationRoundTrip(t *testing.T) {
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

	schema := fmt.Sprintf("issue_status_282_%d", time.Now().UnixNano())
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
			status TEXT NOT NULL
		);
		INSERT INTO issue (id, status) VALUES
			('00000000-0000-0000-0000-000000000001', 'Spec'),
			('00000000-0000-0000-0000-000000000002', 'Queue'),
			('00000000-0000-0000-0000-000000000003', 'in_progress'),
			('00000000-0000-0000-0000-000000000004', 'in_review'),
			('00000000-0000-0000-0000-000000000005', 'Human Review'),
			('00000000-0000-0000-0000-000000000006', 'Done'),
			('00000000-0000-0000-0000-000000000007', 'Cancelled'),
			('00000000-0000-0000-0000-000000000008', 'Archived'),
			('00000000-0000-0000-0000-000000000009', 'backlog'),
			('00000000-0000-0000-0000-000000000010', 'Building'),
			('00000000-0000-0000-0000-000000000011', 'done'),
			('00000000-0000-0000-0000-000000000012', 'CI/CD & Deploy'),
			('00000000-0000-0000-0000-000000000013', 'unknown legacy value'),
			('00000000-0000-0000-0000-000000000014', 'Registered'),
			('00000000-0000-0000-0000-000000000015', 'Parked'),
			('00000000-0000-0000-0000-000000000016', 'Rejected');
		ALTER TABLE issue ADD CONSTRAINT issue_status_check CHECK (
			status IN ('backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled')
		) NOT VALID;
	`); err != nil {
		t.Fatalf("seed scratch issue table: %v", err)
	}

	applyMigrationFile(t, ctx, conn.Conn(), "282_drop_issue_status_check_constraint.up.sql")
	assertIssueStatusDefault(t, ctx, conn.Conn(), "'Spec'::text")
	assertIssueStatuses(t, ctx, conn.Conn(), map[string]string{
		"00000000-0000-0000-0000-000000000001": "Spec",
		"00000000-0000-0000-0000-000000000002": "Queue",
		"00000000-0000-0000-0000-000000000003": "In Progress",
		"00000000-0000-0000-0000-000000000004": "In Review",
		"00000000-0000-0000-0000-000000000005": "Human Review",
		"00000000-0000-0000-0000-000000000006": "Done",
		"00000000-0000-0000-0000-000000000007": "Cancelled",
		"00000000-0000-0000-0000-000000000008": "Archived",
		"00000000-0000-0000-0000-000000000009": "Spec",
		"00000000-0000-0000-0000-000000000010": "In Progress",
		"00000000-0000-0000-0000-000000000011": "Done",
		"00000000-0000-0000-0000-000000000012": "CI/CD & Deploy",
		"00000000-0000-0000-0000-000000000013": "Spec",
		"00000000-0000-0000-0000-000000000014": "Registered",
		"00000000-0000-0000-0000-000000000015": "Spec",
		"00000000-0000-0000-0000-000000000016": "Spec",
	})

	if _, err := conn.Exec(ctx, `
		INSERT INTO issue (id, status) VALUES
			('00000000-0000-0000-0000-000000000017', 'Queue'),
			('00000000-0000-0000-0000-000000000018', 'Human Review'),
			('00000000-0000-0000-0000-000000000019', 'Archived'),
			('00000000-0000-0000-0000-000000000020', 'In Review'),
			('00000000-0000-0000-0000-000000000023', 'CI/CD & Deploy'),
			('00000000-0000-0000-0000-000000000024', 'Registered')
	`); err != nil {
		t.Fatalf("write canonical rows after up: %v", err)
	}

	applyMigrationFile(t, ctx, conn.Conn(), "282_drop_issue_status_check_constraint.down.sql")
	assertIssueStatusDefault(t, ctx, conn.Conn(), "'todo'::text")
	assertIssueStatuses(t, ctx, conn.Conn(), map[string]string{
		"00000000-0000-0000-0000-000000000001": "Spec",
		"00000000-0000-0000-0000-000000000002": "Queue",
		"00000000-0000-0000-0000-000000000003": "in_progress",
		"00000000-0000-0000-0000-000000000004": "in_review",
		"00000000-0000-0000-0000-000000000005": "Human Review",
		"00000000-0000-0000-0000-000000000006": "Done",
		"00000000-0000-0000-0000-000000000007": "Cancelled",
		"00000000-0000-0000-0000-000000000008": "Archived",
		"00000000-0000-0000-0000-000000000009": "backlog",
		"00000000-0000-0000-0000-000000000010": "Building",
		"00000000-0000-0000-0000-000000000011": "done",
		"00000000-0000-0000-0000-000000000012": "CI/CD & Deploy",
		"00000000-0000-0000-0000-000000000013": "unknown legacy value",
		"00000000-0000-0000-0000-000000000014": "Registered",
		"00000000-0000-0000-0000-000000000015": "Spec",
		"00000000-0000-0000-0000-000000000016": "Spec",
		"00000000-0000-0000-0000-000000000017": "todo",
		"00000000-0000-0000-0000-000000000018": "blocked",
		"00000000-0000-0000-0000-000000000019": "cancelled",
		"00000000-0000-0000-0000-000000000020": "In Review",
		"00000000-0000-0000-0000-000000000023": "CI/CD & Deploy",
		"00000000-0000-0000-0000-000000000024": "Registered",
	})

	var sidecarExists bool
	if err := conn.QueryRow(ctx, `SELECT to_regclass('issue_status_282_rollback') IS NOT NULL`).Scan(&sidecarExists); err != nil {
		t.Fatalf("read rollback sidecar: %v", err)
	}
	if sidecarExists {
		t.Fatal("rollback sidecar remains after down")
	}

	if _, err := conn.Exec(ctx, `
		INSERT INTO issue (id, status)
		VALUES ('00000000-0000-0000-0000-000000000025', 'new unrecorded value')
	`); !isCheckViolation(err) {
		t.Fatalf("restored legacy constraint: got %v, want check violation", err)
	}

	applyMigrationFile(t, ctx, conn.Conn(), "282_drop_issue_status_check_constraint.up.sql")
	assertIssueStatuses(t, ctx, conn.Conn(), map[string]string{
		"00000000-0000-0000-0000-000000000012": "CI/CD & Deploy",
		"00000000-0000-0000-0000-000000000013": "Spec",
		"00000000-0000-0000-0000-000000000014": "Registered",
		"00000000-0000-0000-0000-000000000015": "Spec",
		"00000000-0000-0000-0000-000000000016": "Spec",
		"00000000-0000-0000-0000-000000000017": "Spec",
		"00000000-0000-0000-0000-000000000018": "Human Review",
		"00000000-0000-0000-0000-000000000019": "Cancelled",
		"00000000-0000-0000-0000-000000000020": "In Review",
		"00000000-0000-0000-0000-000000000023": "CI/CD & Deploy",
		"00000000-0000-0000-0000-000000000024": "Registered",
	})
}

func assertIssueStatusDefault(t *testing.T, ctx context.Context, conn *pgx.Conn, want string) {
	t.Helper()
	var got string
	if err := conn.QueryRow(ctx, `
		SELECT column_default
		FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'issue' AND column_name = 'status'
	`).Scan(&got); err != nil {
		t.Fatalf("read issue.status default: %v", err)
	}
	if got != want {
		t.Fatalf("issue.status default = %q, want %q", got, want)
	}
}

func assertIssueStatuses(t *testing.T, ctx context.Context, conn *pgx.Conn, want map[string]string) {
	t.Helper()
	for id, expected := range want {
		var actual string
		if err := conn.QueryRow(ctx, `SELECT status FROM issue WHERE id = $1`, id).Scan(&actual); err != nil {
			t.Fatalf("read issue %s: %v", id, err)
		}
		if actual != expected {
			t.Errorf("issue %s status = %q, want %q", id, actual, expected)
		}
	}
}
