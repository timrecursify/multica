package main

import (
	"context"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Keep the hook-result contract compile-checked. A stale `func(...) error`
// closure must fail the package build before any migration can ship.
var (
	_ preMigrationHook = cleanupInvalidConcurrentIndexHook("compile_check")
	_ preMigrationHook = exactConcurrentIndexHook("compile_check", "compile_check")
	_ preMigrationHook = buildBudgetWorkspaceIndexHook("compile_check", "compile_check")
	_ preMigrationHook = runTaskUsageHourlyHook
	_ preMigrationHook = runAttributionStrictHook
)

func TestExactConcurrentIndexHook(t *testing.T) {
	pool := openTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	suffix := fmt.Sprintf("%d_%d", time.Now().UnixNano(), rand.Uint32())
	schema := "migrate_build_budget_" + suffix
	schemaIdent := pgx.Identifier{schema}.Sanitize()
	if _, err := pool.Exec(ctx, "CREATE SCHEMA "+schemaIdent); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+schemaIdent+" CASCADE"); err != nil {
			t.Logf("drop schema: %v", err)
		}
	})

	table := pgx.Identifier{schema, "build_budget"}.Sanitize()
	indexName := "uq_build_budget_scope_workspace_" + suffix
	index := pgx.Identifier{schema, indexName}.Sanitize()
	createIndex := pgx.Identifier{indexName}.Sanitize()
	if _, err := pool.Exec(ctx, "CREATE TABLE "+table+" (workspace_id uuid, scope text, scope_ref text)"); err != nil {
		t.Fatalf("create build_budget: %v", err)
	}

	// An absent relation must let the concurrent migration continue.
	hook := exactConcurrentIndexHook(index, "unused")
	if _, err := hook(ctx, pool); err != nil {
		t.Fatalf("absent index: %v", err)
	}

	if _, err := pool.Exec(ctx, "CREATE UNIQUE INDEX CONCURRENTLY "+createIndex+" ON "+table+" (workspace_id, scope, scope_ref)"); err != nil {
		t.Fatalf("create expected index: %v", err)
	}
	var definition string
	if err := pool.QueryRow(ctx, "SELECT pg_get_indexdef(to_regclass($1))", index).Scan(&definition); err != nil {
		t.Fatalf("read index definition: %v", err)
	}
	skip, err := buildBudgetWorkspaceIndexHookForRelation(table, index, definition)(ctx, pool)
	if err != nil {
		t.Fatalf("existing build_budget: %v", err)
	}
	if skip {
		t.Fatal("existing build_budget skipped migration SQL")
	}
	if _, err := exactConcurrentIndexHook(index, definition)(ctx, pool); err != nil {
		t.Fatalf("expected valid index: %v", err)
	}
	if _, err := exactConcurrentIndexHook(index, definition+" WHERE false")(ctx, pool); err == nil {
		t.Fatal("wrong valid index definition was accepted")
	}
	if _, err := pool.Exec(ctx, "DROP INDEX CONCURRENTLY "+index); err != nil {
		t.Fatalf("drop expected index: %v", err)
	}
	if _, err := pool.Exec(ctx, "INSERT INTO "+table+" VALUES (NULL, 'workspace', 'same'), (NULL, 'workspace', 'same')"); err != nil {
		t.Fatalf("seed duplicate values: %v", err)
	}
	if _, err := pool.Exec(ctx, "CREATE UNIQUE INDEX CONCURRENTLY "+createIndex+" ON "+table+" (workspace_id, scope, scope_ref) NULLS NOT DISTINCT"); err == nil {
		t.Fatal("invalid-index setup unexpectedly succeeded")
	}
	if _, err := exactConcurrentIndexHook(index, definition)(ctx, pool); err != nil {
		t.Fatalf("remove invalid index: %v", err)
	}
	var exists bool
	if err := pool.QueryRow(ctx, "SELECT to_regclass($1) IS NOT NULL", index).Scan(&exists); err != nil {
		t.Fatalf("check invalid index removal: %v", err)
	}
	if exists {
		t.Fatal("invalid index was not removed")
	}
}

func TestBuildBudgetMigrationsSkipCleanSchema(t *testing.T) {
	pool := openTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	suffix := fmt.Sprintf("%d_%d", time.Now().UnixNano(), rand.Uint32())
	schema := "migrate_build_budget_clean_" + suffix
	schemaIdent := pgx.Identifier{schema}.Sanitize()
	if _, err := pool.Exec(ctx, "CREATE SCHEMA "+schemaIdent); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+schemaIdent+" CASCADE"); err != nil {
			t.Logf("drop schema: %v", err)
		}
	})

	dir := t.TempDir()
	files := []struct {
		version string
		sql     string
	}{
		{"286_build_budget_scope_workspace", "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_build_budget_scope_workspace ON build_budget (workspace_id, scope, scope_ref);\n"},
		{"287_build_budget_scope_drop_v1", "DROP INDEX CONCURRENTLY IF EXISTS uq_build_budget_scope;\n"},
	}
	paths := make([]string, 0, len(files))
	for _, file := range files {
		path := filepath.Join(dir, file.version+".up.sql")
		if err := os.WriteFile(path, []byte(file.sql), 0o600); err != nil {
			t.Fatalf("write %s: %v", file.version, err)
		}
		paths = append(paths, path)
	}
	if err := runMigrations(ctx, pool, runOptions{
		Direction:             "up",
		Files:                 paths,
		SchemaMigrationsTable: schema + ".schema_migrations",
		AdvisoryLockKey:       int64(rand.Uint64()&0x7fffffffffffffff) | 1,
		Hooks:                 preMigrationHooks,
	}); err != nil {
		t.Fatalf("clean schema migrations: %v", err)
	}

	var relationExists bool
	if err := pool.QueryRow(ctx, "SELECT to_regclass('public.build_budget') IS NOT NULL").Scan(&relationExists); err != nil {
		t.Fatalf("check build_budget relation: %v", err)
	}
	if relationExists {
		t.Fatal("clean-schema migration created build_budget")
	}
	var versions int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM "+pgx.Identifier{schema, "schema_migrations"}.Sanitize()).Scan(&versions); err != nil {
		t.Fatalf("count recorded migrations: %v", err)
	}
	if versions != len(files) {
		t.Fatalf("recorded migrations = %d, want %d", versions, len(files))
	}
}

func TestRunMigrationsRejectsSkipForOtherVersions(t *testing.T) {
	pool := openTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	suffix := fmt.Sprintf("%d_%d", time.Now().UnixNano(), rand.Uint32())
	schema := "migrate_skip_guard_" + suffix
	schemaIdent := pgx.Identifier{schema}.Sanitize()
	if _, err := pool.Exec(ctx, "CREATE SCHEMA "+schemaIdent); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+schemaIdent+" CASCADE"); err != nil {
			t.Logf("drop schema: %v", err)
		}
	})

	const version = "288_skip_must_fail"
	path := filepath.Join(t.TempDir(), version+".up.sql")
	if err := os.WriteFile(path, []byte("SELECT 1;\n"), 0o600); err != nil {
		t.Fatalf("write migration: %v", err)
	}
	err := runMigrations(ctx, pool, runOptions{
		Direction:             "up",
		Files:                 []string{path},
		SchemaMigrationsTable: schema + ".schema_migrations",
		AdvisoryLockKey:       int64(rand.Uint64()&0x7fffffffffffffff) | 1,
		Hooks: map[string]preMigrationHook{
			version: func(context.Context, *pgxpool.Pool) (bool, error) { return true, nil },
		},
	})
	if err == nil {
		t.Fatal("unexpected skip was accepted")
	}
}
