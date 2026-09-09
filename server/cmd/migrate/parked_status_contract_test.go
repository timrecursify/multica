package main

import (
	"context"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/multica-ai/multica/server/internal/migrations"
)

// TestParkedIssueStatusContractUsesCanonicalRunner exercises migration 312
// after a complete replay of the repository's canonical migration set. The
// ten-status and live-twelve-status cases then simulate the two upgrade
// shapes without replacing the migration runner with hand-applied migration
// SQL.
func TestParkedIssueStatusContractUsesCanonicalRunner(t *testing.T) {
	admin := openTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	suffix := fmt.Sprintf("%d_%d", time.Now().UnixNano(), rand.Uint32())
	schema := "parked_status_contract_" + suffix
	schemaIdent := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schemaIdent); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+schemaIdent+" CASCADE"); err != nil {
			t.Logf("drop schema: %v", err)
		}
	})

	pool := canonicalRunnerPool(t, schema)
	defer pool.Close()

	files, err := migrations.Files("up")
	if err != nil {
		t.Fatalf("list canonical migrations: %v", err)
	}
	if len(files) == 0 || !strings.HasPrefix(filepath.Base(files[len(files)-1]), "312_") {
		t.Fatalf("canonical migration list does not end with 312: %v", files[len(files)-1:])
	}
	lockKey := int64(rand.Uint64()&0x7fffffffffffffff) | 1
	opts := runOptions{
		Direction:             "up",
		Files:                 files,
		SchemaMigrationsTable: schema + ".schema_migrations",
		AdvisoryLockKey:       lockKey,
		Hooks:                 preMigrationHooks,
	}
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatalf("fresh canonical replay: %v", err)
	}
	assertTwelveStatusContract(t, ctx, pool)
	assertParkedReleaseRoute(t, ctx, pool)
	if _, err := pool.Exec(ctx, `
		INSERT INTO "user" (id, name, email) VALUES
			('00000000-0000-0000-0000-000000000101', 'contract test', 'contract-test@example.invalid');
		INSERT INTO workspace (id, name, slug) VALUES
			('00000000-0000-0000-0000-000000000102', 'contract test', 'contract-test');
		INSERT INTO member (id, workspace_id, user_id, role) VALUES
			('00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-000000000101', 'owner');
	`); err != nil {
		t.Fatalf("seed issue fixture owner: %v", err)
	}
	assertUnknownStatusRejected(t, ctx, pool)

	// Re-run only the new migration against the ten-status contract, as an
	// upgrade from the exact schema emitted by migration 285.
	if _, err := pool.Exec(ctx, "DELETE FROM "+pgx.Identifier{schema, "schema_migrations"}.Sanitize()+" WHERE version = $1", migrations.ExtractVersion(files[len(files)-1])); err != nil {
		t.Fatalf("unrecord migration 312: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		ALTER TABLE issue DROP CONSTRAINT issue_status_check;
		ALTER TABLE issue ADD CONSTRAINT issue_status_check CHECK (status IN
			('Registered', 'Spec', 'Queue', 'In Progress', 'In Review',
			 'Human Review', 'CI/CD & Deploy', 'Done', 'Archived', 'Cancelled'));
	`); err != nil {
		t.Fatalf("install ten-status fixture: %v", err)
	}
	if err := runMigrations(ctx, pool, runOptions{
		Direction:             "up",
		Files:                 files[len(files)-1:],
		SchemaMigrationsTable: schema + ".schema_migrations",
		AdvisoryLockKey:       lockKey,
	}); err != nil {
		t.Fatalf("ten-status upgrade: %v", err)
	}
	assertTwelveStatusContract(t, ctx, pool)

	// Simulate a live twelve-status database with real rows and metadata. The
	// migration must still execute atomically and leave both dispositions intact.
	if _, err := pool.Exec(ctx, "DELETE FROM "+pgx.Identifier{schema, "schema_migrations"}.Sanitize()+" WHERE version = $1", migrations.ExtractVersion(files[len(files)-1])); err != nil {
		t.Fatalf("unrecord migration 312 for live fixture: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO issue (id, workspace_id, title, status, creator_type, creator_id, number, metadata) VALUES
			('00000000-0000-0000-0000-000000000104', '00000000-0000-0000-0000-000000000102', 'parked fixture', 'Parked', 'member', '00000000-0000-0000-0000-000000000103', 1, '{"marker":"parked"}'),
			('00000000-0000-0000-0000-000000000105', '00000000-0000-0000-0000-000000000102', 'rejected fixture', 'Rejected', 'member', '00000000-0000-0000-0000-000000000103', 2, '{"marker":"rejected"}');
	`); err != nil {
		t.Fatalf("seed live twelve-status fixture: %v", err)
	}
	if err := runMigrations(ctx, pool, runOptions{
		Direction:             "up",
		Files:                 files[len(files)-1:],
		SchemaMigrationsTable: schema + ".schema_migrations",
		AdvisoryLockKey:       lockKey,
	}); err != nil {
		t.Fatalf("live twelve-status upgrade: %v", err)
	}
	for _, status := range []string{"Parked", "Rejected"} {
		var gotStatus, gotMarker string
		id := map[string]string{"Parked": "00000000-0000-0000-0000-000000000104", "Rejected": "00000000-0000-0000-0000-000000000105"}[status]
		if err := pool.QueryRow(ctx, "SELECT status, metadata->>'marker' FROM issue WHERE id = $1", id).Scan(&gotStatus, &gotMarker); err != nil {
			t.Fatalf("read %s fixture: %v", status, err)
		}
		if gotStatus != status || gotMarker != strings.ToLower(status) {
			t.Fatalf("%s fixture = (%q, %q), want preserved status and metadata", status, gotStatus, gotMarker)
		}
	}
}

func canonicalRunnerPool(t *testing.T, schema string) *pgxpool.Pool {
	t.Helper()
	config, err := pgxpool.ParseConfig(testDatabaseURL())
	if err != nil {
		t.Fatalf("parse database URL: %v", err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema + ",public"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatalf("open canonical runner pool: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Fatalf("ping canonical runner pool: %v", err)
	}
	return pool
}

func testDatabaseURL() string {
	if value := strings.TrimSpace(os.Getenv("DATABASE_URL")); value != "" {
		return value
	}
	return "postgres://multica:multica@localhost:5432/multica?sslmode=disable"
}

func assertTwelveStatusContract(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	var definition string
	if err := pool.QueryRow(ctx, `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'issue'::regclass AND conname = 'issue_status_check'`).Scan(&definition); err != nil {
		t.Fatalf("read issue status constraint: %v", err)
	}
	for _, status := range []string{"Registered", "Spec", "Queue", "In Progress", "In Review", "Human Review", "Parked", "Rejected", "CI/CD & Deploy", "Done", "Archived", "Cancelled"} {
		if !strings.Contains(definition, "'"+status+"'") {
			t.Fatalf("issue status constraint missing %q: %s", status, definition)
		}
	}
}

func assertUnknownStatusRejected(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	_, err := pool.Exec(ctx, `INSERT INTO issue (workspace_id, title, status, creator_type, creator_id) SELECT id, 'unknown status', 'Unknown', 'member', (SELECT id FROM member LIMIT 1) FROM workspace LIMIT 1`)
	if err == nil || !strings.Contains(err.Error(), "issue_status_check") {
		t.Fatalf("unknown status result = %v, want issue_status_check violation", err)
	}
}

func assertParkedReleaseRoute(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	var nextStage string
	if err := pool.QueryRow(ctx, `SELECT next_stage FROM relay_stage_config WHERE id = 11 AND stage_name = 'Parked'`).Scan(&nextStage); err != nil {
		t.Fatalf("read Parked release route: %v", err)
	}
	if nextStage != "Queue" {
		t.Fatalf("Parked release route next stage = %q, want Queue", nextStage)
	}
}
