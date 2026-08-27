package migrations

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// 278_issue_creator_type_nullable must relax ONLY creator_type: creator_id and
// number stay NOT NULL, and the down migration must refuse to restore NOT NULL
// while NULL creator_type rows exist.
func TestIssueCreatorTypeNullableMigration(t *testing.T) {
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
		CREATE TEMP TABLE issue (
			id UUID PRIMARY KEY,
			creator_type TEXT NOT NULL,
			creator_id UUID NOT NULL,
			number integer NOT NULL
		)
	`); err != nil {
		t.Fatalf("create temporary issue table: %v", err)
	}

	applyMigrationFile(t, ctx, conn.Conn(), "278_issue_creator_type_nullable.up.sql")

	assertColumnNullable(t, ctx, conn.Conn(), "creator_type", "YES")
	assertColumnNullable(t, ctx, conn.Conn(), "creator_id", "NO")
	assertColumnNullable(t, ctx, conn.Conn(), "number", "NO")

	insert := func(creatorType, creatorID, number any) error {
		_, err := conn.Exec(ctx, `
			INSERT INTO issue (id, creator_type, creator_id, number)
			VALUES (gen_random_uuid(), $1, $2, $3)
		`, creatorType, creatorID, number)
		return err
	}

	if err := insert(nil, "00000000-0000-0000-0000-000000000001", 1); err != nil {
		t.Fatalf("insert NULL creator_type: %v", err)
	}
	if err := insert("member", nil, 1); !isNotNullViolation(err) {
		t.Fatalf("insert NULL creator_id: got %v, want 23502", err)
	}
	if err := insert("member", "00000000-0000-0000-0000-000000000001", nil); !isNotNullViolation(err) {
		t.Fatalf("insert NULL number: got %v, want 23502", err)
	}

	if _, err := conn.Exec(ctx, readMigrationFile(t, "278_issue_creator_type_nullable.down.sql")); !isNotNullViolation(err) {
		t.Fatalf("down migration with NULL creator_type row: got %v, want 23502", err)
	}
	if _, err := conn.Exec(ctx, `
		UPDATE issue SET creator_type = 'agent' WHERE creator_type IS NULL
	`); err != nil {
		t.Fatalf("repair NULL creator_type rows: %v", err)
	}
	applyMigrationFile(t, ctx, conn.Conn(), "278_issue_creator_type_nullable.down.sql")

	// Re-applying the up migration after rollback must succeed; DROP NOT NULL
	// is idempotent, which keeps crash-window re-runs safe.
	applyMigrationFile(t, ctx, conn.Conn(), "278_issue_creator_type_nullable.up.sql")
}

func assertColumnNullable(t *testing.T, ctx context.Context, conn *pgx.Conn, column, want string) {
	t.Helper()
	var got string
	if err := conn.QueryRow(ctx, `
		SELECT CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END
		FROM pg_attribute a
		WHERE a.attrelid = 'pg_temp.issue'::regclass AND a.attname = $1
	`, column).Scan(&got); err != nil {
		t.Fatalf("read nullability of %s: %v", column, err)
	}
	if got != want {
		t.Fatalf("issue.%s is_nullable = %s, want %s", column, got, want)
	}
}

func isNotNullViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23502"
}
