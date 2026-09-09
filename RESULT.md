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

## BELT P0 work-product gate — ALPHA-000663

- 2026-09-09: Ran the required bounded brain search; it returned prior context about the work-product test setup and belt runtime, with no conflicting instruction.
- 2026-09-09: Checked the orchestrator inbox; no messages were pending.
- 2026-09-09: Read the repository `CLAUDE.md`; this change is scoped to the belt bridge and its tests.
- 2026-09-09: Inspected the gate and tests. `recordBookkeepingHandoff` currently requires both a completed Queue-targeted task and `completionAdmission(result).ok`; the 409 occurs when that helper returns null. The established typed outcome schema uses `issue_stage_outcome(outcome, blocked_on)`, with missing implementation evidence represented by `BLOCKED/sha`.
- 2026-09-09: Patched the bookkeeping handoff so a completed Queue-targeted build task remains mandatory, while a failed/missing structured result writes `In Progress / BLOCKED / sha` and retains the task-correlated relay handoff. No money, destructive, deployment, or Human Review path changed. Extended unit coverage for both artifact-present and artifact-missing handoffs.
- 2026-09-09: First focused test attempt failed before collection: `pg` was not installed (`0 pass, 1 file-level fail`). This is an environment dependency failure, not a test assertion; dependency installation is required before meaningful verification.
- 2026-09-09: `pnpm install --frozen-lockfile` completed successfully, installing the lockfile-defined workspace dependencies without changing the lockfile.
- 2026-09-09: Focused bookkeeping tests passed `6/6` (`0` failed, `0` skipped). The full bridge suite on the change passed `125`, failed `0`, skipped `4`; the same suite from `origin/main` also passed `125`, failed `0`, skipped `4`, so the failing-name diff is empty. Integration cases were explicitly opted out because no test database URL was supplied; they were not presented as exercised.
- 2026-09-09: Read-only production measurement found `2` currently Queue-blocked GSP issues and `0` PPP issues with a completed Queue build and no work-product row; the change therefore admits `2` currently blocked issues (non-zero). It also observed `97` GSP and `13` PPP issues already In Progress with the same missing-product condition. Refined the helper to detect the actual active `issue_work_product` row as well as an invalid completion envelope before writing the typed blocker.
- 2026-09-09: Re-ran the full bridge suite after refining active work-product detection: `125` passed, `0` failed, `4` skipped. A non-opt-out integration run was unavailable because this checkout has no `.env.worktree`; no live database write was attempted.
- 2026-09-09: Final review aligned admission exactly with the ruling: any completed Queue build is admitted; the typed `BLOCKED/sha` outcome is conditional on absence of an active work-product row. The existing no-predecessor gate remains intact.
- 2026-09-09: Final full bridge run passed `125`, failed `0`, skipped `4` (129 tests collected). `git diff --check` passed. Wrote the verified implementation, test, and read-only measurement facts to agent memory as `1788925810-e9614093`.
- 2026-09-09: Created the atomic commit (`fix(belt): admit completed builds without work products`); its pre-amend identifier was `159c385ce`.
- 2026-09-09: Initial push failed because an invalid `GH_TOKEN` shadowed the configured GitHub CLI account. Selected the already-configured `timrecursify` account without exposing or rotating credentials; branch push then succeeded.
- 2026-09-09: Final code commit is `7b15bd284`; pushed branch `belt/work-product-gate-20260909` and opened PR `https://github.com/timrecursify/multica/pull/865`. No deployment, restart, or live-row mutation was performed.
Step 1 — verified repository guidance and root cause context:
- Read CLAUDE.md; backend/reconciler change is in scope and tests use node --test.
- Confirmed stageAttemptsSql() counts stage tasks in the arrival window and cooldown logic separately recognizes completed tasks.

Step 2 — implementation and test:
- Added `NOT (status = 'completed' AND failure_reason IS NULL)` to stageAttemptsSql().
- Added an assertion covering the predicate.
- `node --test ops/belt/reconciler.test.cjs`: 37 tests, 35 pass, 2 fail; both failures are pre-existing real-PostgreSQL regressions requiring DATABASE_URL, with 0 skipped.

Step 3 — live before measurement:
- Read-only query matched 92 issues with last relay failed and last stage task completed with NULL failure_reason.
- Breakdown: GSP Multica Cancelled 1, In Progress 74, Spec 11; PPP Production Cancelled 6, In Progress 5, Spec 2.

Step 4 — corrected release measurement:
- The predicate releases 89 currently-stuck actionable issues: GSP Multica In Progress 73, Spec 9; PPP Production In Progress 5, Spec 2.
- No live rows were updated.

Step 5 — verification:
- `git diff --check` passed.
- Runaway requeue remains bounded by existing `completed_stage_cooldown` and `issue_cooldown` branches in ops/belt/reconciler.cjs:424-430, which skip recent completed or recent same-stage tasks.

## 2026-09-09 ALPHA-000667

- Scope: diagnosis first; code fix only for a proven defect; no deployment or stage-config changes.
- Required pre-investigation `sk brain search` was attempted with a 30-second bound and returned no results before timeout. Root `CLAUDE.md` was read; the first two orchestrator inbox checks returned no messages.
- Production cohort matched `2026-09-08 04:00Z <= created_at < 2026-09-09 04:00Z`. Current mutable statuses show 15 completed and 43 failed In Review rows; the caller observed 45 failed. The 43 current failures classify as 31 QC FAIL verdicts, 3 QC-BLOCKED completions, 3 completed tasks without qualifying evidence, and 6 real worker `agent_error.process_failure` failures.
- Cohort-following the 345 completed In Progress rows by their next relay record gives: 252 re-enter In Progress, 47 go to Human Review, 21 go to In Review, 3 go to Spec, and 22 have no successor record. No immediate successor goes to Queue. Thus the aggregate 345-versus-60 comparison is not a one-to-one funnel.
- Proven code/config disagreement: `requestRetryEscalation` always requested `Spec` for a completed In Review task without qualifying PASS (`ops/belt/parity/multica-relay-advance-daemon.cjs:1507-1523`; `relay-dead-rows.cjs:259-274`). Policy permits system In Review->Spec, but live gsp-multica In Review config does not; PPP does. Added a regression first and changed this deliberate failed-row path to remain In Review for reconciler redispatch.
- Pre-fix regression execution was blocked before discovery because this checkout lacked `node_modules` and could not load `pg`; no behavioral pass/fail is claimed from that attempt.
- Installed frozen workspace dependencies without changing the lockfile. Added both a direct unit regression and the relay integration expectation. Focused post-fix tests passed 1/1 each; `node --check` and `git diff --check` passed.
- A broader three-file run executed 154 tests: 113 passed, 26 failed, 15 skipped. Failures include the known transition-policy fixture drift, unavailable PostgreSQL endpoints (`127.0.0.1:15436` and host `test`), and existing harness drift around advance claims; the two focused changed-path tests pass.
- Wrote verified findings to `sk brain` entry `1788928330-3c4d4b6e`. Rebased onto `origin/main`, pushed the atomic fix, and opened PR #869 (`https://github.com/timrecursify/multica/pull/869`). No deployment or production mutation was performed.
