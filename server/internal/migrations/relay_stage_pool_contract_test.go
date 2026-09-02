package migrations

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestRelayStagePoolImportsAndRollsBackLegacyBinding(t *testing.T) {
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
	schema := fmt.Sprintf("relay_stage_pool_contract_%d", time.Now().UnixNano())
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatalf("create scratch schema: %v", err)
	}
	defer conn.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
	if _, err := conn.Exec(ctx, "SET search_path TO "+schema); err != nil {
		t.Fatalf("select scratch schema: %v", err)
	}
	workspaceID := "11111111-1111-1111-1111-111111111111"
	legacyID := "22222222-2222-2222-2222-222222222222"
	nonMemberID := "33333333-3333-3333-3333-333333333333"
	archivedMemberID := "44444444-4444-4444-4444-444444444444"
	if _, err := conn.Exec(ctx, `
CREATE TABLE agent (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, archived_at timestamptz, permission_mode text NOT NULL DEFAULT 'private');
CREATE TABLE agent_invocation_target (agent_id uuid NOT NULL, target_type text NOT NULL, target_id uuid NOT NULL, UNIQUE (agent_id, target_type, target_id));
CREATE TABLE relay_stage_config (workspace_id uuid NOT NULL, stage_name text NOT NULL, agent_id uuid);
CREATE TABLE relay_stage_agent_pool (workspace_id uuid NOT NULL, stage_name text NOT NULL, agent_id uuid NOT NULL, enabled boolean NOT NULL DEFAULT true);
CREATE UNIQUE INDEX relay_stage_agent_pool_workspace_stage_agent_key ON relay_stage_agent_pool (workspace_id, stage_name, agent_id);
INSERT INTO agent (id, workspace_id) VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111');
INSERT INTO agent (id, workspace_id) VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111');
INSERT INTO agent (id, workspace_id, archived_at) VALUES ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', now());
INSERT INTO relay_stage_config (workspace_id, stage_name, agent_id) VALUES ('11111111-1111-1111-1111-111111111111', 'Queue', '22222222-2222-2222-2222-222222222222');
INSERT INTO relay_stage_agent_pool (workspace_id, stage_name, agent_id) VALUES ('11111111-1111-1111-1111-111111111111', 'Archived', '44444444-4444-4444-4444-444444444444');
`); err != nil {
		t.Fatalf("seed relay contract: %v", err)
	}
	for _, migration := range []string{
		"298_relay_stage_pool_contract.up.sql",
		"299_relay_stage_pool_unique.up.sql",
		"300_relay_stage_pool_import_legacy.up.sql",
		"303_relay_pool_invocation_grants.up.sql",
	} {
		applyMigrationFile(t, ctx, conn.Conn(), migration)
	}
	applyMigrationFile(t, ctx, conn.Conn(), "303_relay_pool_invocation_grants.up.sql")
	// A live enabled member is granted exactly one workspace target; agents
	// outside enabled membership, including archived rows, stay deny-by-default.
	for _, tc := range []struct {
		id, wantMode string
		wantTargets  int
	}{
		{legacyID, "public_to", 1}, {nonMemberID, "private", 0}, {archivedMemberID, "private", 0},
	} {
		var mode string
		var targets int
		if err := conn.QueryRow(ctx, `SELECT permission_mode FROM agent WHERE id=$1::uuid`, tc.id).Scan(&mode); err != nil {
			t.Fatalf("read mode: %v", err)
		}
		if err := conn.QueryRow(ctx, `SELECT count(*) FROM agent_invocation_target WHERE agent_id=$1::uuid AND target_type='workspace'`, tc.id).Scan(&targets); err != nil {
			t.Fatalf("read targets: %v", err)
		}
		if mode != tc.wantMode || targets != tc.wantTargets {
			t.Errorf("agent %s mode/targets = %s/%d, want %s/%d", tc.id, mode, targets, tc.wantMode, tc.wantTargets)
		}
	}
	var imported string
	if err := conn.QueryRow(ctx, `SELECT legacy_agent_id::text FROM relay_stage_pool WHERE workspace_id=$1::uuid AND stage_name='Queue'`, workspaceID).Scan(&imported); err != nil {
		t.Fatalf("read imported legacy binding: %v", err)
	}
	if imported != legacyID {
		t.Fatalf("legacy_agent_id = %s, want %s", imported, legacyID)
	}
	applyMigrationFile(t, ctx, conn.Conn(), "300_relay_stage_pool_import_legacy.down.sql")
	applyMigrationFile(t, ctx, conn.Conn(), "299_relay_stage_pool_unique.down.sql")
	applyMigrationFile(t, ctx, conn.Conn(), "298_relay_stage_pool_contract.down.sql")
	var preserved string
	if err := conn.QueryRow(ctx, `SELECT agent_id::text FROM relay_stage_config WHERE workspace_id=$1::uuid AND stage_name='Queue'`, workspaceID).Scan(&preserved); err != nil {
		t.Fatalf("read legacy binding after rollback: %v", err)
	}
	if preserved != legacyID {
		t.Fatalf("rollback changed legacy agent_id = %s, want %s", preserved, legacyID)
	}
}
