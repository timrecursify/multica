package migrations

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestRelayStageConfigSeedRepairsSequenceAndArchiverMetadata(t *testing.T) {
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

	schema := fmt.Sprintf("relay_stage_seed_%d", time.Now().UnixNano())
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
		CREATE SEQUENCE relay_stage_config_id_seq;
		CREATE TABLE relay_stage_config (
			id integer PRIMARY KEY DEFAULT nextval('relay_stage_config_id_seq'),
			stage_name text NOT NULL UNIQUE,
			next_stage text,
			agent_id uuid,
			agent_name text,
			created_at timestamptz DEFAULT now(),
			alt_next_stages text[]
		);
		ALTER SEQUENCE relay_stage_config_id_seq OWNED BY relay_stage_config.id;
		INSERT INTO relay_stage_config (id, stage_name, next_stage, agent_name)
		VALUES
			(1, 'Registered', 'Spec', 'gsp-spec-sol-low-public'),
			(2, 'Spec', 'Queue', 'gsp-build-terra-low-02'),
			(3, 'Queue', 'In Progress', 'gsp-build-terra-low-02'),
			(4, 'In Progress', 'In Review', 'gsp-qc-sol-low-1'),
			(5, 'In Review', 'CI/CD & Deploy', 'gsp-deploy-sol-low-1'),
			(6, 'Human Review', 'CI/CD & Deploy', 'gsp-deploy-sol-low-1'),
			(7, 'CI/CD & Deploy', 'Done', 'gsp-deploy-sol-low-1'),
			(8, 'Done', 'Archived', 'multica-archiver'),
			(9, 'Archived', NULL, NULL),
			(10, 'Cancelled', NULL, NULL),
			(11, 'Parked', 'Queue', 'gsp-build-terra-low-02');
		SELECT setval('relay_stage_config_id_seq', 11, true);
	`); err != nil {
		t.Fatalf("seed scratch relay config: %v", err)
	}

	for _, migration := range []string{
		"289_relay_stage_config_workspace_column.up.sql",
		"290_relay_stage_config_workspace_seed.up.sql",
		"291_relay_stage_config_workspace_stage_unique.up.sql",
		"292_relay_stage_config_workspace_rollback_prep.up.sql",
		"293_relay_stage_config_sequence_metadata_repair.up.sql",
	} {
		applyMigrationFile(t, ctx, conn.Conn(), migration)
	}

	var archiver string
	if err := conn.QueryRow(ctx, `
		SELECT agent_name FROM relay_stage_config
		WHERE workspace_id = 'f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f'::uuid AND id = 8
	`).Scan(&archiver); err != nil {
		t.Fatalf("read GSP Done metadata: %v", err)
	}
	if archiver != "multica-archiver" {
		t.Fatalf("GSP Done agent_name = %q, want multica-archiver", archiver)
	}

	var pppArchiver *string
	if err := conn.QueryRow(ctx, `
		SELECT agent_name FROM relay_stage_config
		WHERE workspace_id = 'da3c5c5c-a123-4567-b999-c3ed1820da00'::uuid AND id = 19
	`).Scan(&pppArchiver); err != nil {
		t.Fatalf("read PPP Done metadata: %v", err)
	}
	if pppArchiver != nil {
		t.Fatalf("PPP Done agent_name = %q, want NULL", *pppArchiver)
	}

	var id int
	if err := conn.QueryRow(ctx, `
		INSERT INTO relay_stage_config (workspace_id, stage_name)
		VALUES ('f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f'::uuid, 'Scratch Stage')
		RETURNING id
	`).Scan(&id); err != nil {
		t.Fatalf("insert default relay stage row: %v", err)
	}
	if id != 23 {
		t.Fatalf("default relay stage id = %d, want 23", id)
	}
	if _, err := conn.Exec(ctx, `DELETE FROM relay_stage_config WHERE id = $1`, id); err != nil {
		t.Fatalf("remove baseline scratch row: %v", err)
	}

	assertNextDefaultID := func(sequenceValue int, isCalled bool, stageName string, want int) {
		t.Helper()
		if _, err := conn.Exec(ctx, `SELECT setval(pg_get_serial_sequence('relay_stage_config', 'id'), $1, $2)`, sequenceValue, isCalled); err != nil {
			t.Fatalf("set sequence to %d/%t: %v", sequenceValue, isCalled, err)
		}
		applyMigrationFile(t, ctx, conn.Conn(), "293_relay_stage_config_sequence_metadata_repair.up.sql")
		var nextID int
		if err := conn.QueryRow(ctx, `
			INSERT INTO relay_stage_config (workspace_id, stage_name)
			VALUES ('f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f'::uuid, $1)
			RETURNING id
		`, stageName).Scan(&nextID); err != nil {
			t.Fatalf("insert %s after sequence repair: %v", stageName, err)
		}
		if nextID != want {
			t.Fatalf("default id for %s = %d, want %d", stageName, nextID, want)
		}
		if _, err := conn.Exec(ctx, `DELETE FROM relay_stage_config WHERE id = $1`, nextID); err != nil {
			t.Fatalf("remove %s scratch row: %v", stageName, err)
		}
	}

	// A behind, called sequence is moved to MAX(id); an ahead sequence is
	// preserved for both called states; equal/uncalled is made called.
	assertNextDefaultID(10, true, "Behind Called", 23)
	assertNextDefaultID(100, true, "Ahead Called", 101)
	assertNextDefaultID(100, false, "Ahead Uncalled", 100)
	assertNextDefaultID(22, false, "Equal Uncalled", 23)

	if _, err := conn.Exec(ctx, `DELETE FROM relay_stage_config`); err != nil {
		t.Fatalf("empty scratch relay config: %v", err)
	}
	if _, err := conn.Exec(ctx, `SELECT setval(pg_get_serial_sequence('relay_stage_config', 'id'), 1, false)`); err != nil {
		t.Fatalf("reset empty sequence: %v", err)
	}
	applyMigrationFile(t, ctx, conn.Conn(), "293_relay_stage_config_sequence_metadata_repair.up.sql")
	if err := conn.QueryRow(ctx, `
		INSERT INTO relay_stage_config (workspace_id, stage_name)
		VALUES ('f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f'::uuid, 'Empty Stage')
		RETURNING id
	`).Scan(&id); err != nil {
		t.Fatalf("insert into empty relay config: %v", err)
	}
	if id != 1 {
		t.Fatalf("default id on empty relay config = %d, want 1", id)
	}
}
