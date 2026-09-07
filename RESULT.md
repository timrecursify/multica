# Multica belt optimisation — ALPHA-000192

## Outcome

Built three bounded changes on `fix/belt-throughput-20260907`: fixed same-stage replay/attempt ceilings, consumed stale retry-escalation state on stage departure, and wired the bridge suite to a PostgreSQL 17/pgvector CI service with declared Node dependencies. No deploy occurred: `sk graph build --timeout-seconds 600 --dirty` completed its census but failed publication with a `status.json SHA mismatch` (GSP-2428), and the newly enabled bridge suite exposes 18 existing failures. Production remained unchanged.

## Recon and ranking

- Observer 05:33Z: 244 open, 1 live task, 177 tasks/hour, 1 closure/hour, 184 frozen issues; `WATCH-REPORT.md` exact queries are retained in the observer worktree.
- Six-hour relay query returned 1,733 completed rows, 400 same-stage (23.1%): In Progress 200, Queue 89, Spec 84, In Review 24, CI/CD & Deploy 3.
- Six-hour task query returned 1,579 completed, 678 failed, 220 distinct completed-task issues. Issue-update closure query returned 29 Done/Archived; 54.4 completed tasks per observed closure is directional because populations differ.
- Frozen current-stage query found 90 In Progress issues with no live task. Their current outcomes included FAILED 29, NO_OP 20, ADVANCED 10, and no outcome 9.
- Spec Sol-low is not healthy enough to trust solely from green existence: observer found 16 completed and 93 failed in two hours, though at least one green completion exists.
- Ranking from Astra ALPHA-000198: bounded recovery/ceiling first, convergence/evidence second, dependency cache third. Cache integration is deferred because installer ownership was not located; Human Review/Astra routing remains proposal-only.

## Items

1. Re-dispatch gap: cause is split between parity recovery and reconciler admission. `ops/belt/parity/multica-relay-advance-daemon.cjs` now refuses a second replay by `retry_of_task_id` and records `same_stage_no_advance`; `ops/belt/reconciler.cjs` no longer raises `max_attempts` to `attempt + 1`; `ops/belt/stage-outcome.cjs` checks exhaustion before its no-outcome early return. Commit `7d1e42d3d`.
2. Token waste: unchanged attempts are now bounded. Focused reconciler/outcome QC passed 41/41. Exact causality by spec quality remains unverified; the live gate-shim outage produced 423 refused tasks since 22:46Z and is supervisor-owned by ALPHA-000164.
3. GSP-2400 cache: design completed in WORKBOOK.md; implementation deferred because installer ownership is unverified. No cache code was guessed.
4. Re-park trap: `ops/belt/multica-bridge.cjs` removes active `metadata.retry_escalation` when leaving its trigger stage while retaining `retry_escalation_at`. Focused lifecycle test passed 1/1. Commit `b42dc6f5b`.
5. ADVANCED downgraded without PR: observer now measured 0 in two hours. Existing `ops/belt/stage-outcome.cjs` PR/head validation remains; no additional change was justified.
6. Human Review: 17 non-excluded tickets were observed. No tickets were moved and no Astra agent row was created; global routing change requires seat sign-off.
7. Deploy verification: `bin/ppp-deploy-artifact` belongs to PPP checkouts, not this Multica worktree. Unchanged; PPP-24178 remains Parked.
8. CI: `.github/workflows/ci.yml` now provisions `pgvector/pgvector:pg17`, installs frozen pnpm dependencies, and runs the bridge suite with a non-sentinel DATABASE_URL. Root `package.json` now declares `jsonwebtoken`; frozen install passes. Commit `b42dc6f5b` plus `3f3ec1bee`.

## Exact recon queries

```sql
SELECT count(*) completed_transitions, count(*) FILTER (WHERE from_stage=to_stage) no_stage_change, round(100.0*count(*) FILTER (WHERE from_stage=to_stage)/NULLIF(count(*),0),1) pct FROM relay_run_log WHERE status='completed' AND created_at>NOW()-interval '6 hours';
SELECT from_stage,count(*) FROM relay_run_log WHERE status='completed' AND from_stage=to_stage AND created_at>NOW()-interval '6 hours' GROUP BY from_stage ORDER BY count(*) DESC;
SELECT count(*) FILTER (WHERE status='completed') completed, count(*) FILTER (WHERE status='failed') failed, count(DISTINCT issue_id) FILTER (WHERE status='completed') completed_issues FROM agent_task_queue WHERE completed_at>NOW()-interval '6 hours';
SELECT count(*) FROM issue WHERE status IN ('Done','Archived') AND updated_at>NOW()-interval '6 hours';
```

## QC, blockers, next action

- PASS: `pnpm install --frozen-lockfile`; reconciler/outcome tests 41/41; retry lifecycle focused test 1/1; Node syntax for bridge, reconciler, and parity daemon; YAML parse; `git diff --check`.
- FAIL: full bridge suite collected 108 tests: 86 pass, 18 fail, 4 skip. The failures predate these focused changes but mean the new CI job will correctly stay red until repaired.
- BLOCKED: Docker socket denied, so the pgvector integration could not run locally. `sk graph` covered 2,076/2,076 supported files then failed its receipt SHA verification; GSP-2428 tracks it.
- Next action: repair GSP-2428 and the 18 bridge regressions, rebase/push/open PR, then deploy one packet at a time and measure 30 minutes before/after. No production receipt or after metrics exist because deployment was not safe.

## Seat asks

1. Provide the supervisor-owned privileged rollout for ALPHA-000164's gate-shim fix; its local wrapper test passed but both worker restarts are blocked by `sudo -n`.
2. Decide whether to configure the proposed Astra Human Review lane; no routing row was changed.
