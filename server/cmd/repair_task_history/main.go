// repair_task_history restores UUID task parents from an authoritative CSV.
package main

import (
	"context"
	"encoding/csv"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const integrityLockSQL = `SELECT pg_advisory_xact_lock(hashtextextended('agent_task_queue_uuid_integrity', 0))`
const integrityTablesLockSQL = `LOCK TABLE agent_task_queue, task_message, task_usage IN SHARE ROW EXCLUSIVE MODE`

type task struct {
	id, agentID, issueID, status string
}

type counts struct {
	messages, usage, messageOrphans, usageOrphans int64
	messageChecksum, usageChecksum                string
}

func main() {
	var input, databaseURL string
	var dryRun bool
	flag.StringVar(&input, "input", "", "authoritative CSV with id,agent_id,issue_id,status columns")
	flag.StringVar(&databaseURL, "database-url", os.Getenv("DATABASE_URL"), "Postgres connection URL (defaults to DATABASE_URL)")
	flag.BoolVar(&dryRun, "dry-run", false, "validate and report without committing")
	flag.Parse()
	if input == "" || databaseURL == "" {
		fatal(errors.New("--input and --database-url (or DATABASE_URL) are required"))
	}
	if err := run(context.Background(), input, databaseURL, dryRun, os.Stdout); err != nil {
		fatal(err)
	}
}

func run(ctx context.Context, input, databaseURL string, dryRun bool, out io.Writer) error {
	tasks, err := readTasks(input)
	if err != nil {
		return err
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer pool.Close()
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, integrityLockSQL); err != nil {
		return fmt.Errorf("advisory lock: %w", err)
	}
	if _, err = tx.Exec(ctx, integrityTablesLockSQL); err != nil {
		return fmt.Errorf("table locks: %w", err)
	}
	before, err := taskCounts(ctx, tx)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "before task_message_rows=%d task_usage_rows=%d task_message_orphans=%d task_usage_orphans=%d task_message_checksum=%s task_usage_checksum=%s\n", before.messages, before.usage, before.messageOrphans, before.usageOrphans, before.messageChecksum, before.usageChecksum)
	for _, item := range tasks {
		if err := verifyReferences(ctx, tx, item); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO agent_task_queue (id, agent_id, issue_id, status) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET agent_id = EXCLUDED.agent_id, issue_id = EXCLUDED.issue_id, status = EXCLUDED.status`, item.id, item.agentID, item.issueID, item.status); err != nil {
			return fmt.Errorf("upsert task %s: %w", item.id, err)
		}
	}
	after, err := taskCounts(ctx, tx)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "after task_message_rows=%d task_usage_rows=%d task_message_orphans=%d task_usage_orphans=%d task_message_checksum=%s task_usage_checksum=%s\n", after.messages, after.usage, after.messageOrphans, after.usageOrphans, after.messageChecksum, after.usageChecksum)
	if after.messages != before.messages || after.usage != before.usage {
		return errors.New("child row counts changed during repair")
	}
	if after.messageChecksum != before.messageChecksum || after.usageChecksum != before.usageChecksum {
		return errors.New("child row checksums changed during repair")
	}
	if after.messageOrphans != 0 || after.usageOrphans != 0 {
		return errors.New("repair incomplete: authoritative export did not restore every referenced task")
	}
	if dryRun {
		fmt.Fprintln(out, "dry-run: rolling back")
		return nil
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	fmt.Fprintf(out, "committed restored_tasks=%d\n", len(tasks))
	return nil
}

func readTasks(path string) ([]task, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	reader := csv.NewReader(file)
	header, err := reader.Read()
	if err != nil {
		return nil, fmt.Errorf("read header: %w", err)
	}
	if strings.Join(header, ",") != "id,agent_id,issue_id,status" {
		return nil, errors.New("CSV header must be id,agent_id,issue_id,status")
	}
	seen := make(map[string]task)
	for line := 2; ; line++ {
		record, err := reader.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read CSV line %d: %w", line, err)
		}
		if len(record) != 4 {
			return nil, fmt.Errorf("CSV line %d: expected four columns", line)
		}
		item := task{strings.TrimSpace(record[0]), strings.TrimSpace(record[1]), strings.TrimSpace(record[2]), strings.TrimSpace(record[3])}
		if _, err := uuid.Parse(item.id); err != nil {
			return nil, fmt.Errorf("CSV line %d: invalid id: %w", line, err)
		}
		if _, err := uuid.Parse(item.agentID); err != nil {
			return nil, fmt.Errorf("CSV line %d: invalid agent_id: %w", line, err)
		}
		if _, err := uuid.Parse(item.issueID); err != nil {
			return nil, fmt.Errorf("CSV line %d: invalid issue_id: %w", line, err)
		}
		if item.status == "" {
			return nil, fmt.Errorf("CSV line %d: status is required", line)
		}
		if prior, exists := seen[item.id]; exists && prior != item {
			return nil, fmt.Errorf("CSV line %d: conflicting duplicate task id %s", line, item.id)
		}
		seen[item.id] = item
	}
	result := make([]task, 0, len(seen))
	for _, item := range seen {
		result = append(result, item)
	}
	return result, nil
}

func verifyReferences(ctx context.Context, tx pgx.Tx, item task) error {
	for _, reference := range []struct{ table, value string }{{"agent", item.agentID}, {"issue", item.issueID}} {
		var exists bool
		if err := tx.QueryRow(ctx, fmt.Sprintf("SELECT EXISTS (SELECT 1 FROM %s WHERE id = $1)", reference.table), reference.value).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return fmt.Errorf("task %s references missing %s %s", item.id, reference.table, reference.value)
		}
	}
	return nil
}

func taskCounts(ctx context.Context, tx pgx.Tx) (counts, error) {
	var result counts
	err := tx.QueryRow(ctx, `SELECT
        (SELECT count(*) FROM task_message),
        (SELECT count(*) FROM task_usage),
        (SELECT count(*) FROM task_message m LEFT JOIN agent_task_queue q ON q.id = m.task_id WHERE m.task_id IS NOT NULL AND q.id IS NULL),
        (SELECT count(*) FROM task_usage u LEFT JOIN agent_task_queue q ON q.id = u.task_id WHERE u.task_id IS NOT NULL AND q.id IS NULL),
        (SELECT COALESCE(md5(string_agg(id::text, ',' ORDER BY id::text)), '') FROM task_message),
        (SELECT COALESCE(md5(string_agg(id::text, ',' ORDER BY id::text)), '') FROM task_usage)`).Scan(&result.messages, &result.usage, &result.messageOrphans, &result.usageOrphans, &result.messageChecksum, &result.usageChecksum)
	return result, err
}

func fatal(err error) { fmt.Fprintln(os.Stderr, "repair_task_history:", err); os.Exit(1) }
