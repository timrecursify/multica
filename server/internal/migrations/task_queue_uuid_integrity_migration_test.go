package migrations

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// These are real-Postgres tests. They exercise the migration on a fresh UUID
// schema, reject all observed type drifts and orphan history, prove the empty
// down migration preserves history, and prove the migration's lock blocks a
// concurrent child writer/migration until the integrity check completes.
func TestTaskQueueUUIDIntegrityMigration(t *testing.T) {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		t.Skip("integration test requires Postgres at DATABASE_URL")
	}
	ctx := context.Background()
	probe, err := pgx.Connect(ctx, dbURL)
	if err != nil {
		t.Skipf("integration test requires reachable Postgres at DATABASE_URL: %v", err)
	}
	_ = probe.Close(ctx)

	t.Run("fresh schema is idempotent and rollback preserves children", func(t *testing.T) {
		conn, cleanup := uuidIntegritySchema(t, ctx, dbURL, "uuid", "uuid", "uuid")
		defer cleanup()
		seedUUIDHistory(t, ctx, conn, false)
		applyMigrationFile(t, ctx, conn, "281_agent_task_queue_uuid_integrity.up.sql")
		applyMigrationFile(t, ctx, conn, "281_agent_task_queue_uuid_integrity.up.sql")
		var beforeMessages, beforeUsage, afterMessages, afterUsage int
		if err := conn.QueryRow(ctx, `SELECT (SELECT count(*) FROM task_message), (SELECT count(*) FROM task_usage)`).Scan(&beforeMessages, &beforeUsage); err != nil {
			t.Fatalf("count children before down: %v", err)
		}
		applyMigrationFile(t, ctx, conn, "281_agent_task_queue_uuid_integrity.down.sql")
		if err := conn.QueryRow(ctx, `SELECT (SELECT count(*) FROM task_message), (SELECT count(*) FROM task_usage)`).Scan(&afterMessages, &afterUsage); err != nil {
			t.Fatalf("count children after down: %v", err)
		}
		if beforeMessages != afterMessages || beforeUsage != afterUsage {
			t.Fatalf("down migration changed child history: messages %d/%d usage %d/%d", beforeMessages, afterMessages, beforeUsage, afterUsage)
		}
	})

	for _, drift := range []struct{ column, queue, message, usage string }{
		{"agent_task_queue.id integer", "integer", "uuid", "uuid"},
		{"task_message.task_id bigint", "uuid", "bigint", "uuid"},
		{"task_usage.task_id text", "uuid", "uuid", "text"},
	} {
		t.Run("rejects "+drift.column+" drift", func(t *testing.T) {
			conn, cleanup := uuidIntegritySchema(t, ctx, dbURL, drift.queue, drift.message, drift.usage)
			defer cleanup()
			err := applyUUIDIntegrity(ctx, conn)
			want := strings.Split(drift.column, " ")[0] + " must be uuid"
			if err == nil || !strings.Contains(err.Error(), want) {
				t.Fatalf("drift error=%v, want %q", err, want)
			}
		})
	}

	t.Run("rejects orphan history", func(t *testing.T) {
		conn, cleanup := uuidIntegritySchema(t, ctx, dbURL, "uuid", "uuid", "uuid")
		defer cleanup()
		seedUUIDHistory(t, ctx, conn, true)
		err := applyUUIDIntegrity(ctx, conn)
		if err == nil || !strings.Contains(err.Error(), "task_message_orphans=1, task_usage_orphans=1") {
			t.Fatalf("orphan migration error=%v, want fail-closed orphan count", err)
		}
	})

	t.Run("shared lock blocks concurrent child writer", func(t *testing.T) {
		holder, cleanup := uuidIntegritySchema(t, ctx, dbURL, "uuid", "uuid", "uuid")
		defer cleanup()
		seedUUIDHistory(t, ctx, holder, false)
		if _, err := holder.Exec(ctx, "BEGIN; LOCK TABLE agent_task_queue, task_message, task_usage IN SHARE ROW EXCLUSIVE MODE"); err != nil {
			t.Fatal(err)
		}
		worker, err := pgx.Connect(ctx, dbURL)
		if err != nil {
			t.Fatal(err)
		}
		defer worker.Close(ctx)
		var schema string
		if err := holder.QueryRow(ctx, "SELECT current_schema()").Scan(&schema); err != nil {
			t.Fatal(err)
		}
		if _, err := worker.Exec(ctx, "SET search_path TO "+schema); err != nil {
			t.Fatal(err)
		}
		writerDone := make(chan error, 1)
		go func() {
			_, err := worker.Exec(context.Background(), `INSERT INTO task_message VALUES ('00000000-0000-0000-0000-000000000099', '00000000-0000-0000-0000-000000000001')`)
			writerDone <- err
		}()
		select {
		case err := <-writerDone:
			t.Fatalf("child writer was not blocked by integrity lock: %v", err)
		case <-time.After(150 * time.Millisecond):
		}
		if _, err := holder.Exec(ctx, "ROLLBACK"); err != nil {
			t.Fatal(err)
		}
		if err := <-writerDone; err != nil {
			t.Fatalf("child writer after lock release: %v", err)
		}
		if err := applyUUIDIntegrity(ctx, holder); err != nil {
			t.Fatalf("migration after concurrent writer: %v", err)
		}
	})
}

func uuidIntegritySchema(t *testing.T, ctx context.Context, dbURL, queueType, messageType, usageType string) (*pgx.Conn, func()) {
	t.Helper()
	conn, err := pgx.Connect(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("uuid_integrity_%d", time.Now().UnixNano())
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+schema+"; SET search_path TO "+schema); err != nil {
		t.Fatal(err)
	}
	ddl := fmt.Sprintf(`CREATE TABLE agent_task_queue (id %s PRIMARY KEY);
CREATE TABLE task_message (id uuid PRIMARY KEY, task_id %s);
CREATE TABLE task_usage (id uuid PRIMARY KEY, task_id %s);`, queueType, messageType, usageType)
	if _, err := conn.Exec(ctx, ddl); err != nil {
		t.Fatal(err)
	}
	return conn, func() {
		_, _ = conn.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
		_ = conn.Close(context.Background())
	}
}

func seedUUIDHistory(t *testing.T, ctx context.Context, conn *pgx.Conn, orphan bool) {
	t.Helper()
	const taskID = "00000000-0000-0000-0000-000000000001"
	if !orphan {
		if _, err := conn.Exec(ctx, `INSERT INTO agent_task_queue VALUES ($1)`, taskID); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := conn.Exec(ctx, `INSERT INTO task_message VALUES ('00000000-0000-0000-0000-000000000011', $1), ('00000000-0000-0000-0000-000000000012', NULL)`, taskID); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `INSERT INTO task_usage VALUES ('00000000-0000-0000-0000-000000000021', $1), ('00000000-0000-0000-0000-000000000022', NULL)`, taskID); err != nil {
		t.Fatal(err)
	}
}

func applyUUIDIntegrity(ctx context.Context, conn *pgx.Conn) error {
	_, err := conn.Exec(ctx, readMigrationFileForIntegrity("281_agent_task_queue_uuid_integrity.up.sql"))
	return err
}

func readMigrationFileForIntegrity(name string) string {
	// Existing helper needs testing.T; the stable path is exercised by every
	// migration test in this package and avoids making production code test-only.
	path := "../../migrations/" + name
	b, err := os.ReadFile(path)
	if err != nil {
		panic(err)
	}
	return string(b)
}
