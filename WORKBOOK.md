# Belt throughput workbook — 2026-09-07

Branch: `fix/belt-throughput-20260907`. Baseline snapshot: observer 05:33Z reports 244 open, 1 live task, 177 tasks/hour, 1 closure/hour, and 184 frozen issues. Six-hour query: 1,733 completed relay rows, 400 same-stage (23.1%); 1,579 completed tasks and 29 issue closures (54.4 completed tasks per observed closure; populations differ). PPP-23686 is excluded.

## Order

1. P0 gate-shim rollout is owned by ALPHA-000164 and supervisor; this branch does not touch it. Its local fix passed, but rollout is blocked on privileged deployment.
2. Packet A: stop unchanged-input outcome loops and fix the moving attempt ceiling. Highest direct closure leverage across 90 frozen In Progress issues.
3. Packet B: clear consumed retry-escalation state after a real stage departure so historic escalation cannot re-park a later visit.
4. Packet C: make the bridge integration suite run in CI with PostgreSQL 17/pgvector.
5. Packet D: dependency cache primitive only. Installer ownership remains unverified, so integration is deferred rather than guessed.
6. Deploy verification and Human Review/Astra routing remain proposals until their owning paths and supervisor authority are available.

## Packet A — convergence admission

- Write-set: `ops/belt/stage-outcome.cjs`, `ops/belt/stage-outcome.test.cjs`, `ops/belt/reconciler.cjs`, `ops/belt/reconciler.test.cjs`, plus a small new helper if needed to restore file/function limits.
- Change: keep `maxAttempts` fixed instead of raising it to `attempt + 1`; allow at most one explicitly reasoned same-stage replay per stage visit, then persist exhaustion. Do not dispatch Parked, Human Review, or CI/CD & Deploy.
- Tests: concurrent reconciliation creates one replay; crash before commit consumes none; replay cannot seed another replay; changed inputs use ordinary admission but do not replenish replay; caps/cooldowns/live-task checks still win; missing PR rejects In Progress ADVANCED.
- Budget: Luna-low 24k tokens, 2.0 engineer-hours; Sol QC 1.0 hour.
- Rollback: revert admission code only; retain task/outcome audit history and consumed budgets.

## Packet B — retry escalation lifecycle

- Write-set: `ops/belt/multica-bridge.cjs`, `ops/belt/multica-bridge.test.cjs`.
- Change: consume/clear `metadata.retry_escalation` when the issue leaves its recorded trigger stage; preserve audit timestamp. A later stage visit must not match stale `trigger_stage`.
- Tests: first verified escalation re-specs; a second escalation in the same visit parks; successful departure clears the active marker; returning later does not re-park from stale metadata.
- Budget: Luna-low 12k tokens, 1.0 engineer-hour; Sol QC 0.5 hour.
- Rollback: revert bridge change; no data deletion.

## Packet C — bridge CI coverage

- Write-set: `.github/workflows/ci.yml` only.
- Change: belt-runtime job starts throwaway `pgvector/pgvector:pg17`, supplies a real test database URL, and runs `ops/belt/multica-bridge.test.cjs` without its sentinel self-skip.
- Tests: workflow syntax; local bridge test against throwaway PostgreSQL; prove test count is nonzero.
- Budget: Luna-low 8k tokens, 0.75 engineer-hour; Sol QC 0.5 hour.
- Rollback: revert workflow-only commit.

## Packet D — dependency-cache primitive

- Write-set: new `ops/belt/dependency-cache.cjs` and test only.
- Change: immutable cache key from repository identity, lockfile digest, runtime/ABI and install flags; private build, process-owned lock, validation, atomic ready publication; no shared writable `node_modules`; Python final-path venv only.
- Tests: one producer per key; lockfile/runtime changes miss; producer crash leaves no ready entry; corruption invalidates; concurrent consumers cannot mutate shared state.
- Budget: Luna-low 16k tokens, 1.5 engineer-hours; Sol QC 0.5 hour.
- Rollback: cache remains unused until a separately scoped installer integration packet.

## Production acceptance

Deploy one packet at a time through the belt receipt path to both PPP and GSP. For 30 minutes after each deploy record exact queries for closures/hour, completed tasks per closure, and completed same-stage rows; compare process start time and `pm_exec_path` with deployed file mtime. Roll back first if closures/hour falls. No manual ticket closures, load-governor bypass, credential changes, or Human Review moves.
