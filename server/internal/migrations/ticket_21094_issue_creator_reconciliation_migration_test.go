package migrations

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestTicket21094ReconcilesReconstructedIssueCreators(t *testing.T) {
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

	if _, err := conn.Exec(ctx, `
		CREATE TEMP TABLE member (
			id UUID PRIMARY KEY,
			workspace_id UUID NOT NULL,
			created_at TIMESTAMPTZ NOT NULL
		);
		CREATE TEMP TABLE issue (
			id UUID PRIMARY KEY,
			workspace_id UUID NOT NULL,
			title TEXT NOT NULL,
			creator_type TEXT,
			creator_id UUID
		);
	`); err != nil {
		t.Fatalf("create temporary tables: %v", err)
	}

	const workspaceID = "00000000-0000-0000-0000-000000000010"
	const firstMemberID = "00000000-0000-0000-0000-000000000011"
	const secondMemberID = "00000000-0000-0000-0000-000000000012"
	const issueID = "00000000-0000-0000-0000-000000000013"
	if _, err := conn.Exec(ctx, `
		INSERT INTO member (id, workspace_id, created_at) VALUES
			($1, $2, '2026-01-01T00:00:00Z'),
			($3, $2, '2026-01-02T00:00:00Z');
		INSERT INTO issue (id, workspace_id, title) VALUES
			($4, $2, 'RECONSTRUCTED ticket');
	`, firstMemberID, workspaceID, secondMemberID, issueID); err != nil {
		t.Fatalf("insert reconstruction fixture: %v", err)
	}

	applyMigrationFile(t, ctx, conn.Conn(), "281_ticket_21094_reconcile_reconstructed_issue_creators.up.sql")

	var creatorType, creatorID string
	if err := conn.QueryRow(ctx, `SELECT creator_type, creator_id FROM issue WHERE id = $1`, issueID).Scan(&creatorType, &creatorID); err != nil {
		t.Fatalf("read repaired issue: %v", err)
	}
	if creatorType != "member" || creatorID != firstMemberID {
		t.Fatalf("creator = (%q, %q), want (member, %s)", creatorType, creatorID, firstMemberID)
	}

	assertColumnNullable(t, ctx, conn.Conn(), "creator_type", "NO")
	assertColumnNullable(t, ctx, conn.Conn(), "creator_id", "NO")
	assertInsertCheckViolation(t, ctx, conn.Conn(), `
		INSERT INTO issue (id, workspace_id, title, creator_type, creator_id)
		VALUES ('00000000-0000-0000-0000-000000000014', $1, 'invalid creator', 'system', $2)
	`, workspaceID, firstMemberID)
}
