// repair_task_history restores missing task parents from an authoritative CSV
// export. It never derives attribution from child rows.
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

type parent struct{ id, agentID, issueID, status string }

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "repair task history:", err)
		os.Exit(1)
	}
}

func run() error {
	input := flag.String("input", "", "authoritative CSV (id,agent_id,issue_id,status)")
	dryRun := flag.Bool("dry-run", false, "validate and report without writing")
	flag.Parse()
	if *input == "" {
		return errors.New("--input is required; refusing to synthesize parent rows")
	}
	rows, err := readParents(*input)
	if err != nil {
		return err
	}
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		return errors.New("DATABASE_URL is required")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer pool.Close()
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(27421111)"); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "LOCK TABLE agent_task_queue, task_message, task_usage IN SHARE ROW EXCLUSIVE MODE"); err != nil {
		return err
	}
	var beforeMessages, beforeUsage int64
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM task_message m LEFT JOIN agent_task_queue q ON q.id=m.task_id WHERE q.id IS NULL`).Scan(&beforeMessages); err != nil {
		return err
	}
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM task_usage u LEFT JOIN agent_task_queue q ON q.id=u.task_id WHERE q.id IS NULL`).Scan(&beforeUsage); err != nil {
		return err
	}
	inserted := int64(0)
	for _, p := range rows {
		var exists bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_task_queue WHERE id=$1)`, p.id).Scan(&exists); err != nil {
			return err
		}
		if exists {
			continue
		}
		var refs int
		if err = tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM agent WHERE id=$1) + (SELECT count(*) FROM issue WHERE id=$2)`, p.agentID, p.issueID).Scan(&refs); err != nil {
			return err
		}
		if refs != 2 {
			return fmt.Errorf("parent %s references missing agent or issue", p.id)
		}
		if _, err = tx.Exec(ctx, `INSERT INTO agent_task_queue (id, agent_id, issue_id, status) VALUES ($1,$2,$3,$4)`, p.id, p.agentID, p.issueID, p.status); err != nil {
			return err
		}
		inserted++
	}
	var afterMessages, afterUsage int64
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM task_message m LEFT JOIN agent_task_queue q ON q.id=m.task_id WHERE q.id IS NULL`).Scan(&afterMessages); err != nil {
		return err
	}
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM task_usage u LEFT JOIN agent_task_queue q ON q.id=u.task_id WHERE q.id IS NULL`).Scan(&afterUsage); err != nil {
		return err
	}
	fmt.Printf("orphan task_message: %d -> %d\norphan task_usage: %d -> %d\ncandidate parents: %d\ninserted parents: %d\n", beforeMessages, afterMessages, beforeUsage, afterUsage, len(rows), inserted)
	if afterMessages != 0 || afterUsage != 0 {
		return errors.New("authoritative export does not cover every orphan; rolled back")
	}
	if *dryRun {
		return nil
	}
	return tx.Commit(ctx)
}

func readParents(path string) ([]parent, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	r := csv.NewReader(f)
	header, err := r.Read()
	if err != nil {
		return nil, err
	}
	idx := map[string]int{}
	for i, name := range header {
		idx[strings.TrimSpace(name)] = i
	}
	for _, name := range []string{"id", "agent_id", "issue_id", "status"} {
		if _, ok := idx[name]; !ok {
			return nil, fmt.Errorf("CSV is missing required %q column", name)
		}
	}
	seen := map[string]parent{}
	var out []parent
	for line := 2; ; line++ {
		rec, err := r.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("CSV line %d: %w", line, err)
		}
		p := parent{id: rec[idx["id"]], agentID: rec[idx["agent_id"]], issueID: rec[idx["issue_id"]], status: rec[idx["status"]]}
		if _, err := uuid.Parse(p.id); err != nil {
			return nil, fmt.Errorf("CSV line %d: invalid id: %w", line, err)
		}
		if _, err := uuid.Parse(p.agentID); err != nil {
			return nil, fmt.Errorf("CSV line %d: invalid agent_id: %w", line, err)
		}
		if _, err := uuid.Parse(p.issueID); err != nil {
			return nil, fmt.Errorf("CSV line %d: invalid issue_id: %w", line, err)
		}
		if p.status == "" {
			return nil, fmt.Errorf("CSV line %d: empty status", line)
		}
		if old, ok := seen[p.id]; ok {
			if old != p {
				return nil, fmt.Errorf("CSV line %d: conflicting duplicate id %s", line, p.id)
			}
			continue
		}
		seen[p.id] = p
		out = append(out, p)
	}
	return out, nil
}
