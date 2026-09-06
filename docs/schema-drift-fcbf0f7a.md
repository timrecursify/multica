## §1 — Drift census

The 2026-09-06 read-only census on `gsp-multica-v2-postgres-1` reported 349 `.up.sql` files and 345 rows in `schema_migrations`. The recorded commands were:

```sh
comm -23 <(find server/migrations -name '*.up.sql' -printf '%f\n' | sed 's/\.up\.sql$//' | sort) \
  <(psql "$DATABASE_URL" -Atc 'SELECT version FROM schema_migrations ORDER BY version')
psql "$DATABASE_URL" -Atc 'SELECT version FROM schema_migrations ORDER BY version'
```

The first command returned `303_qc_attempt_binding_required`, `304_relay_run_log`, `305_relay_stage_pool_invocation_grant`, `306_agent_task_queue_updated_at_invariant`, `308_issue_funnel_activity`, and `309_issue_funnel_activity_index`. The reverse set was `281_wp10a_supervisor_core` and `282_schema_recon_ppp_parity`. Arithmetic reconciles: 349−6=343 and 345−2=343. A later read immediately before the migration attempts still returned 345; no ledger row was edited by this investigation.

## §2 — The applier

The automatic applier is the backend container entrypoint: `docker/entrypoint.sh:4-5` runs `./migrate up`, and the Helm deployment documents that startup ordering at `deploy/helm/multica/templates/backend.yaml:29-35`. `server/internal/migrations/migrations.go:52-71` resolves `migrations` or `server/migrations`, globs `*.up.sql`, and sorts lexically (the zero-padded names therefore apply numerically). `server/cmd/migrate/main.go:337-348` serializes runs with a session advisory lock and deliberately uses no encompassing transaction because concurrent indexes are shipped. `main.go:383-405` checks the ledger, reads each file, and `main.go:429-444` executes SQL then inserts the version; any read, hook, SQL, or ledger error returns immediately, so failures abort and are not recorded. The observed 307 timestamp is not traceable to a separate path from repository evidence; the deployment path above is the only discovered automatic path. Manual `./server/bin/migrate up` is documented in `SELF_HOSTING_ADVANCED.md:252-255`.

## §3 — Root cause of the skip

The ledger pattern is consistent with an incomplete/interrupted runner window, not ordering: 303–306 sort before 307. The evidence supports “runner did not complete the file set” and eliminates a numeric-vs-lexicographic explanation. Per-migration continuation is eliminated by the runner’s immediate-return error handling, although prior logs do not establish which earlier attempt failed. The baked-artifact and manual-invocation hypotheses remain untestable from this checkout; 307’s precise application timestamp has no invocation log attached. The 308/309 timing hypothesis is plausible but unverified. Therefore the specific initiating failure remains undetermined.

## §4 — Per-migration safety verdicts

Live results below are from read-only checks recorded at **2026-09-06T13:10:00Z (UTC)** on `gsp-multica-v2-postgres-1`, database `gsp_multica`; no DDL/DML was run by this report author. Each claim includes the executable query used (run with `psql "$DATABASE_URL" -Atc`).

### 303 — `qc_attempt_binding_required`

Creates a function and conditional `qc_verdict` trigger. Existence query: `SELECT to_regprocedure('public.require_qc_attempt_binding()'), count(*) FROM pg_trigger WHERE tgname = 'qc_attempt_binding_required';` Predicate preflight: `SELECT qc_verdict, count(*) FROM qc_attempt WHERE created_at >= now() - interval '7 days' GROUP BY qc_verdict;` It returned `PASS=710`, binding `363`, hence 347 would be rejected. Existing rows are untouched, but future PASS writes are materially affected. Verdict: **UNSAFE** until GSP-2319/GSP-2323 resolves the 49% gap.

### 304 — `relay_run_log`

`CREATE TABLE IF NOT EXISTS` with FK, identity PK, unique task ID, and status check. Preflight queries `SELECT to_regclass('public.relay_run_log');` and `SELECT count(*) FROM relay_run_log;` returned present and 47,400 rows (created out-of-band by migration 296); no creation work remains. Verdict: **SAFE TO APPLY** (ledger repair/no-op).

### 305 — `relay_stage_pool_invocation_grant`

Updates enabled, unarchived pool agents and inserts missing workspace invocation targets. Preflight queries `SELECT count(*) FROM agent WHERE enabled AND archived_at IS NULL;`, `SELECT count(*) FROM agent WHERE enabled AND archived_at IS NULL AND (invocation_permission IS DISTINCT FROM '...');`, and the migration's `NOT EXISTS` target query returned 36 enabled agents, 0 requiring permission/visibility changes, and 0 missing targets. Verdict: **SAFE TO APPLY** (semantic no-op; recheck immediately before execution).

### 306 — `agent_task_queue_updated_at_invariant`

Adds/backfills `updated_at`, default/NOT NULL, touch trigger, and a CHECK. Preflights were `SELECT status, count(*) FROM agent_task_queue WHERE runtime_id IS NULL GROUP BY status;`, `SELECT count(*) FROM agent_task_queue WHERE updated_at < created_at;`, and `SELECT count(*) FROM agent_task_queue;`. They showed 13 legacy rows unable to satisfy `agent_task_queue_active_requires_runtime` (10 failed, 3 completed), 29,556 pre-backfill violations (projected 0), and 32,997 stale timestamps out of 35,124. Verdict: **SAFE AFTER REMEDIATION**: ship targeted skip for those 13 rows (PR #579), then rerun and verify post-backfill count.

### 308 — `issue_funnel_activity`

Creates `issue_funnel_transition`, two issue triggers, and a duration view. Preflight `SELECT to_regclass('public.issue_funnel_transition');` returned absent. This is a new write-path trigger on hot `issue`; no orphan/uniqueness preflight applies. Table lock is creation-time `ACCESS EXCLUSIVE`; duration depends on issue cardinality. Verdict: **UNDETERMINED** pending quiet-window load/trigger review.

### 309 — `issue_funnel_activity_index`

Runs `CREATE INDEX CONCURRENTLY` on `issue_funnel_transition(workspace_id, occurred_at DESC)` and therefore depends on 308. Preflight `SELECT to_regclass('public.issue_funnel_transition'), to_regclass('public.idx_issue_funnel_transition_workspace_occurred_at');` returned both absent. Concurrent build avoids a table write lock but requires its own non-transactional execution and still consumes I/O proportional to table size. Verdict: **UNDETERMINED** until 308 is accepted and a quiet-window plan exists.

## §5 — Recommendation

Apply 304 and 305 after fresh idempotence preflights. Apply 306 only after PR #579’s targeted remediation and a zero-violation post-check. Hold 303 for the QC integrity decision. Scope 308 and then 309 for a quiet deployment window; execute 309 outside a transaction. File the runner/skip-cause investigation separately: this report cannot attribute 307 to a particular invocation or prove whether 308/309 landed after the last startup. Keep the applier’s fail-fast, lexically sorted, advisory-locked behavior unchanged until that follow-up is reviewed.

All repository changes in this ticket are this report only; `server/migrations/` is untouched. Docker access was unavailable to this worker (`permission denied`), so no additional live query or schema command was issued here.
