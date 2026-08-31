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

// TestRelayStageConfigCancelRoundTrip proves migration 290 sanctions Cancelled
// as a terminal successor of the active work stages (notably Queue -> Cancelled)
// while preserving next_stage for ordinary transitions, and that it is additive
// and idempotent (a re-apply changes nothing).
func TestRelayStageConfigCancelRoundTrip(t *testing.T) {
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

	schema := fmt.Sprintf("relay_cancel_290_%d", time.Now().UnixNano())
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

	// Seed the live relay graph shape: the operator surface (migration 283)
	// adds alt_next_stages and the terminal Cancelled row, but the active
	// stages (Queue etc.) still omit Cancelled from their successor edges.
	// We replicate that exact pre-290 state inline so the test does not depend
	// on the still-unmerged 283 migration.
	if _, err := conn.Exec(ctx, `
		CREATE TABLE relay_stage_config (
			id integer PRIMARY KEY,
			stage_name text NOT NULL UNIQUE,
			next_stage text,
			agent_id uuid,
			agent_name text,
			created_at timestamptz NOT NULL DEFAULT now(),
			alt_next_stages text[]
		);
		INSERT INTO relay_stage_config (id, stage_name, next_stage, alt_next_stages) VALUES
			(1,  'Registered',    'Spec',            NULL),
			(2,  'Spec',          'Queue',           ARRAY['Human Review','Cancelled']),
			(3,  'Queue',         'In Progress',     ARRAY['Human Review']),
			(4,  'In Progress',   'In Review',       ARRAY['Human Review','Queue']),
			(5,  'In Review',     'CI/CD & Deploy',  ARRAY['Human Review','In Progress']),
			(6,  'Human Review',  'CI/CD & Deploy',  ARRAY['Cancelled','In Progress','Queue']),
			(7,  'CI/CD & Deploy','Done',            ARRAY['In Progress','Queue','Spec']),
			(8,  'Done',          'Archived',        ARRAY['CI/CD & Deploy']),
			(9,  'Archived',      NULL,              ARRAY['CI/CD & Deploy']),
			(10, 'Cancelled',     NULL,              NULL);
	`); err != nil {
		t.Fatalf("seed relay_stage_config: %v", err)
	}

	// Baseline: before 290, Queue and the other active stages do NOT admit Cancelled.
	assertTransitionLegal(t, ctx, conn.Conn(), "Queue", "Cancelled", false)
	assertTransitionLegal(t, ctx, conn.Conn(), "In Progress", "Cancelled", false)
	// Ordinary next_stage transitions remain legal at baseline.
	assertTransitionLegal(t, ctx, conn.Conn(), "Queue", "In Progress", true)

	// Apply 290 and verify Cancelled is now a sanctioned successor.
	applyMigrationFile(t, ctx, conn.Conn(), "290_relay_stage_config_cancel.up.sql")
	assertTransitionLegal(t, ctx, conn.Conn(), "Queue", "Cancelled", true)
	assertTransitionLegal(t, ctx, conn.Conn(), "In Progress", "Cancelled", true)
	assertTransitionLegal(t, ctx, conn.Conn(), "In Review", "Cancelled", true)
	assertTransitionLegal(t, ctx, conn.Conn(), "CI/CD & Deploy", "Cancelled", true)
	// Ordinary transitions and next_stage are untouched.
	assertTransitionLegal(t, ctx, conn.Conn(), "Queue", "In Progress", true)
	assertStageNext(t, ctx, conn.Conn(), "Queue", "In Progress")
	assertTerminal(t, ctx, conn.Conn(), "Cancelled")

	// Re-applying 290 is a no-op (idempotent).
	applyMigrationFile(t, ctx, conn.Conn(), "290_relay_stage_config_cancel.up.sql")
	assertTransitionLegal(t, ctx, conn.Conn(), "Queue", "Cancelled", true)

	// Down revokes the Cancelled successor but leaves next_stage intact.
	applyMigrationFile(t, ctx, conn.Conn(), "290_relay_stage_config_cancel.down.sql")
	assertTransitionLegal(t, ctx, conn.Conn(), "Queue", "Cancelled", false)
	assertTransitionLegal(t, ctx, conn.Conn(), "Queue", "In Progress", true)

	// A second up restores the sanctioned path (complete round trip).
	applyMigrationFile(t, ctx, conn.Conn(), "290_relay_stage_config_cancel.up.sql")
	assertTransitionLegal(t, ctx, conn.Conn(), "Queue", "Cancelled", true)
}

// assertTransitionLegal reports whether the relay's successor rule (next_stage
// plus alt_next_stages) admits fromStage -> toStage.
func assertTransitionLegal(t *testing.T, ctx context.Context, conn *pgx.Conn, fromStage, toStage string, want bool) {
	t.Helper()
	var next *string
	var alts []string
	if err := conn.QueryRow(ctx,
		`SELECT next_stage, COALESCE(alt_next_stages, '{}')
		   FROM relay_stage_config WHERE stage_name = $1`, fromStage,
	).Scan(&next, &alts); err != nil {
		t.Fatalf("read stage %s: %v", fromStage, err)
	}
	allowed := false
	if next != nil && *next == toStage {
		allowed = true
	}
	for _, s := range alts {
		if s == toStage {
			allowed = true
		}
	}
	if allowed != want {
		t.Fatalf("transition %s -> %s: allowed=%v, want %v", fromStage, toStage, allowed, want)
	}
}

func assertStageNext(t *testing.T, ctx context.Context, conn *pgx.Conn, stage, wantNext string) {
	t.Helper()
	var got *string
	if err := conn.QueryRow(ctx,
		`SELECT next_stage FROM relay_stage_config WHERE stage_name = $1`, stage,
	).Scan(&got); err != nil {
		t.Fatalf("read next_stage for %s: %v", stage, err)
	}
	if got == nil || *got != wantNext {
		t.Fatalf("next_stage for %s = %v, want %s", stage, got, wantNext)
	}
}

func assertTerminal(t *testing.T, ctx context.Context, conn *pgx.Conn, stage string) {
	t.Helper()
	var next *string
	var alts []string
	if err := conn.QueryRow(ctx,
		`SELECT next_stage, COALESCE(alt_next_stages, '{}')
		   FROM relay_stage_config WHERE stage_name = $1`, stage,
	).Scan(&next, &alts); err != nil {
		t.Fatalf("read stage %s: %v", stage, err)
	}
	if next != nil {
		t.Fatalf("stage %s is not terminal: next_stage = %v", stage, *next)
	}
}
