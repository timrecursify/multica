package main

import (
	"context"
	"fmt"
	"math/rand/v2"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
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
	index := pgx.Identifier{schema, "uq_build_budget_scope_workspace"}.Sanitize()
	if _, err := pool.Exec(ctx, "CREATE TABLE "+table+" (workspace_id uuid, scope text, scope_ref text)"); err != nil {
		t.Fatalf("create build_budget: %v", err)
	}

	// An absent relation must let the concurrent migration continue.
	hook := exactConcurrentIndexHook(index, "unused")
	if err := hook(ctx, pool); err != nil {
		t.Fatalf("absent index: %v", err)
	}

	if _, err := pool.Exec(ctx, "CREATE UNIQUE INDEX CONCURRENTLY "+index+" ON "+table+" (workspace_id, scope, scope_ref)"); err != nil {
		t.Fatalf("create expected index: %v", err)
	}
	var definition string
	if err := pool.QueryRow(ctx, "SELECT pg_get_indexdef(to_regclass($1))", index).Scan(&definition); err != nil {
		t.Fatalf("read index definition: %v", err)
	}
	if err := exactConcurrentIndexHook(index, definition)(ctx, pool); err != nil {
		t.Fatalf("expected valid index: %v", err)
	}
	if err := exactConcurrentIndexHook(index, definition+" WHERE false")(ctx, pool); err == nil {
		t.Fatal("wrong valid index definition was accepted")
	}
	if _, err := pool.Exec(ctx, "DROP INDEX CONCURRENTLY "+index); err != nil {
		t.Fatalf("drop expected index: %v", err)
	}
	if _, err := pool.Exec(ctx, "INSERT INTO "+table+" VALUES (NULL, 'workspace', 'same'), (NULL, 'workspace', 'same')"); err != nil {
		t.Fatalf("seed duplicate values: %v", err)
	}
	if _, err := pool.Exec(ctx, "CREATE UNIQUE INDEX CONCURRENTLY "+index+" ON "+table+" (workspace_id, scope, scope_ref) NULLS NOT DISTINCT"); err == nil {
		t.Fatal("invalid-index setup unexpectedly succeeded")
	}
	if err := exactConcurrentIndexHook(index, definition)(ctx, pool); err != nil {
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
