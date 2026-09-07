package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/multica-ai/multica/server/internal/migrations"
)

type auditReport struct {
	Status  string   `json:"status"`
	Reasons []string `json:"reasons,omitempty"`
	Ledger  []string `json:"ledger"`
	Files   []string `json:"files"`
}

func validateLedger(files, ledger []string) []string {
	var reasons []string
	want := make(map[string]int, len(files))
	for _, v := range files {
		want[v]++
	}
	got := make(map[string]int, len(ledger))
	for _, v := range ledger {
		got[v]++
	}
	for v, n := range got {
		if want[v] == 0 {
			reasons = append(reasons, "extra_ledger:"+v)
		}
		if n > 1 {
			reasons = append(reasons, "duplicate_ledger:"+v)
		}
	}
	for v, n := range want {
		if got[v] == 0 {
			reasons = append(reasons, "missing_ledger:"+v)
		}
		if n > 1 {
			reasons = append(reasons, "duplicate_file:"+v)
		}
	}
	index := make(map[string]int, len(files))
	for i, v := range files {
		index[v] = i
	}
	last := -1
	for _, v := range ledger {
		if i, ok := index[v]; ok {
			if i < last {
				reasons = append(reasons, "out_of_order_ledger:"+v)
			}
			last = i
		}
	}
	sort.Strings(reasons)
	return reasons
}

// auditLedger compares the release migration set with the database ledger and
// checks the durable objects/data contracts introduced by migrations 303-306.
// It is deliberately read-only so deploy automation can run it before and
// after rollout without changing production state.
func auditLedger(ctx context.Context, pool *pgxpool.Pool, files []string) (auditReport, error) {
	report := auditReport{Status: "ok"}
	for _, f := range files {
		report.Files = append(report.Files, migrations.ExtractVersion(f))
	}
	if len(report.Files) == 0 {
		return report, fmt.Errorf("no migration files")
	}
	rows, err := pool.Query(ctx, `SELECT version FROM schema_migrations ORDER BY applied_at, version`)
	if err != nil {
		return report, fmt.Errorf("read schema_migrations: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return report, err
		}
		report.Ledger = append(report.Ledger, v)
	}
	if err := rows.Err(); err != nil {
		return report, err
	}
	report.Reasons = validateLedger(report.Files, report.Ledger)
	checks := []struct{ name, sql string }{
		{"303_function", `SELECT to_regprocedure('public.require_qc_attempt_binding()') IS NOT NULL`},
		{"304_table", `SELECT to_regclass('public.relay_run_log') IS NOT NULL`},
		{"306_column", `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='agent_task_queue' AND column_name='updated_at')`},
		{"306_function", `SELECT to_regprocedure('public.agent_task_queue_touch_updated_at()') IS NOT NULL`},
		{"306_trigger", `SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='agent_task_queue_touch_updated_at' AND NOT tgisinternal)`},
		{"306_constraint", `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='agent_task_queue_updated_at_after_started_at')`},
	}
	for _, c := range checks {
		var ok bool
		if err := pool.QueryRow(ctx, c.sql).Scan(&ok); err != nil {
			return report, fmt.Errorf("check %s: %w", c.name, err)
		}
		if !ok {
			report.Reasons = append(report.Reasons, "missing_object:"+c.name)
		}
	}
	// Migration 305 is data-only: enabled pool members must have workspace
	// visibility and an invocation target, which is the durable contract.
	var bad int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM agent a JOIN relay_stage_agent_pool p ON p.agent_id=a.id AND p.workspace_id=a.workspace_id AND p.enabled WHERE a.archived_at IS NULL AND (a.visibility <> 'workspace' OR NOT EXISTS (SELECT 1 FROM agent_invocation_target t WHERE t.agent_id=a.id AND t.target_type='workspace' AND t.target_id=a.workspace_id))`).Scan(&bad); err != nil {
		return report, fmt.Errorf("check 305 contract: %w", err)
	}
	if bad > 0 {
		report.Reasons = append(report.Reasons, fmt.Sprintf("305_contract_violations:%d", bad))
	}
	sort.Strings(report.Reasons)
	if len(report.Reasons) > 0 {
		report.Status = "drift"
	}
	return report, nil
}

func runAudit(ctx context.Context, pool *pgxpool.Pool) int {
	files, err := migrations.Files("up")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	report, err := auditLedger(ctx, pool, files)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	b, _ := json.Marshal(report)
	fmt.Println(string(b))
	if report.Status != "ok" {
		return 2
	}
	return 0
}
