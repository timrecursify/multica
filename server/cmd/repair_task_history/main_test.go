package main

import (
	"bytes"
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestRepairTaskHistory_RealPostgresDryRunCommitAndIdempotency(t *testing.T) {
	adminURL := os.Getenv("DATABASE_URL")
	if adminURL == "" {
		adminURL = "postgres://multica:multica@localhost:5432/multica?sslmode=disable"
	}
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Skipf("integration test requires Postgres at DATABASE_URL: %v", err)
	}
	defer admin.Close(ctx)
	dbName := fmt.Sprintf("repair_task_history_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+dbName); err != nil {
		t.Fatalf("create temporary database: %v", err)
	}
	t.Cleanup(func() { _, _ = admin.Exec(context.Background(), "DROP DATABASE IF EXISTS "+dbName+" WITH (FORCE)") })
	dbURL := repairTestDatabaseURL(t, adminURL, dbName)
	pool, err := pgx.Connect(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close(ctx)
	if _, err := pool.Exec(ctx, `
		CREATE TABLE agent (id uuid PRIMARY KEY);
		CREATE TABLE issue (id uuid PRIMARY KEY);
		CREATE TABLE agent_task_queue (id uuid PRIMARY KEY, agent_id uuid NOT NULL, issue_id uuid NOT NULL, status text NOT NULL);
		CREATE TABLE task_message (id uuid PRIMARY KEY, task_id uuid);
		CREATE TABLE task_usage (id uuid PRIMARY KEY, task_id uuid);
		INSERT INTO agent VALUES ('00000000-0000-0000-0000-000000000101');
		INSERT INTO issue VALUES ('00000000-0000-0000-0000-000000000201');
		INSERT INTO task_message VALUES ('00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000001');
		INSERT INTO task_usage VALUES ('00000000-0000-0000-0000-000000000401', '00000000-0000-0000-0000-000000000001');
	`); err != nil {
		t.Fatal(err)
	}
	csv := filepath.Join(t.TempDir(), "parents.csv")
	if err := os.WriteFile(csv, []byte("id,agent_id,issue_id,status\n00000000-0000-0000-0000-000000000001,00000000-0000-0000-0000-000000000101,00000000-0000-0000-0000-000000000201,completed\n"), 0600); err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	if err := run(ctx, csv, dbURL, true, &out); err != nil {
		t.Fatalf("dry run: %v", err)
	}
	if !strings.Contains(out.String(), "before task_message_rows=1 task_usage_rows=1 task_message_orphans=1 task_usage_orphans=1") || !strings.Contains(out.String(), "after task_message_rows=1 task_usage_rows=1 task_message_orphans=0 task_usage_orphans=0") {
		t.Fatalf("missing required repair evidence: %s", out.String())
	}
	var parents int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM agent_task_queue").Scan(&parents); err != nil || parents != 0 {
		t.Fatalf("dry run persisted parent count=%d err=%v", parents, err)
	}
	out.Reset()
	if err := run(ctx, csv, dbURL, false, &out); err != nil {
		t.Fatalf("commit repair: %v", err)
	}
	if err := run(ctx, csv, dbURL, false, &out); err != nil {
		t.Fatalf("idempotent repair: %v", err)
	}
	var messages, usage, orphans int
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM task_message), (SELECT count(*) FROM task_usage), (SELECT count(*) FROM task_message m LEFT JOIN agent_task_queue q ON q.id=m.task_id WHERE q.id IS NULL)`).Scan(&messages, &usage, &orphans); err != nil || messages != 1 || usage != 1 || orphans != 0 {
		t.Fatalf("post-repair rows messages=%d usage=%d orphans=%d err=%v", messages, usage, orphans, err)
	}
}

func TestReadTasksRejectsConflictingDuplicate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "conflicting.csv")
	contents := "id,agent_id,issue_id,status\n" +
		"00000000-0000-0000-0000-000000000001,00000000-0000-0000-0000-000000000101,00000000-0000-0000-0000-000000000201,completed\n" +
		"00000000-0000-0000-0000-000000000001,00000000-0000-0000-0000-000000000101,00000000-0000-0000-0000-000000000201,failed\n"
	if err := os.WriteFile(path, []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readTasks(path); err == nil || !strings.Contains(err.Error(), "conflicting duplicate task id") {
		t.Fatalf("readTasks error=%v, want conflicting duplicate rejection", err)
	}
}

func repairTestDatabaseURL(t *testing.T, raw, database string) string {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + database
	return u.String()
}
