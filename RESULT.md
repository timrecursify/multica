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
## 2026-09-09 ALPHA-000665

- Step 1: Ran the required bounded `sk brain search` before investigation. It returned a directly relevant prior verified memory stating typed readvance should reuse completed-task QC evidence and hold invalid QC evidence; no source assumptions were taken from memory without verification.
- Step 2: Read `sk help brain` and polled the orchestrator inbox at the first safe boundary; the inbox contained no messages.
- Step 3: Verified the worktree initially differed only by this run's `RESULT.md`. Read the root `CLAUDE.md`. Bounded `git grep` confirmed the typed-readvance function, QC MD5 normalization/selection, two existing payload callers, bridge comparison, and relevant daemon/integration tests at the paths and line neighborhoods stated in the assignment.
- Step 4: Source inspection verified `qcCompletionAdvance(row)` accepts only an In Review→CI/CD & Deploy transition with a completed task, PASS verdict, valid 32-hex verdict MD5, and strict evidence bound to the same MD5/SHA/qualifying completed Sol-low task. `readvanceRecordedOutcomes` already computes that validated object but omits its `workProductMd5` from `postRelay`. Existing unit coverage checks evidence and a FAIL skip but does not assert this payload field or all missing/FAIL/stale denial variants. The final bounded grep had no package-script match and returned 1; all requested source reads completed.
- Step 5: Added regression expectations first: a valid current PASS must put its exact MD5 in the typed-readvance payload, while missing, FAIL, and stale/mismatched strict evidence must make zero relay posts. The first test attempt could not load the suite because the checkout lacks the `pg` module (0 pass, 1 loader failure, 0 skipped); this is an environment/dependency failure before test discovery, not a behavioral result.
- Step 6: Ran `pnpm install --frozen-lockfile`; it completed successfully with the lockfile unchanged and installed the workspace dependencies needed to execute the requested suite.
- Step 7: Pre-fix suite result after dependency installation: 110 tests, 88 pass, 7 fail, 15 skip. The new test failed exactly as intended (`typed In Review re-advance supplies strict QC pass evidence`: payload MD5 was `undefined`). The other six failures were the existing policy-row expectation plus five PostgreSQL integration tests unable to connect to local port 15436.
- Step 8: Implemented the smallest transport-only fix: the typed-readvance `postRelay` payload conditionally includes `qcAdvance.workProductMd5` only when the existing strict `qcCompletionAdvance` validation succeeds. No bridge gate, reconciler candidate selection, CI sweep, or workspace behavior was changed.
- Step 9: Verified the live-measurement schema contract in source and prepared a read-only query. It counts distinct nonterminal issues whose current `qc_effective_verdict` is qualifying PASS with a valid MD5 and whose active work product is bound to the same scope revision, grouped by workspace slug.
- Step 10: The first live read-only measurement returned zero rows. That query was narrower than the requested bridge contract because it required the new canonical `issue_work_product` scope binding, while the Done gate itself defines “current PASS and work product” as the latest `qc_verdict` being PASS with its MD5. Revised the measurement to mirror that exact current-verdict contract without changing any live data.
- Step 11: Live read-only measurement matching the bridge's latest-verdict contract found 17 nonterminal issues: `gsp-multica|5` and `ppp-production|12`. No credential value or issue row was printed or modified.
- Step 12: Post-fix daemon suite result: 110 tests, 89 pass, 6 fail, 15 skip. The new matching-PASS payload test and all three missing/FAIL/stale denial tests pass. Remaining failures are `completion evidence satisfies every automatic transition policy row` plus five named PostgreSQL tests failing because 127.0.0.1:15436 is unavailable.
- Step 13: Created a detached, bounded comparison worktree inside this assigned checkout at exact base `origin/main` commit `14929da43` for the required same-suite baseline; no production state was touched.
- Step 14: Installed the exact base worktree dependencies with `pnpm install --frozen-lockfile`; installation completed and did not alter the lockfile.
- Step 15: Exact base `14929da43` suite result: 108 tests, 87 pass, 6 fail, 15 skip. Failing names are identical to the patched run: `completion evidence satisfies every automatic transition policy row`; `assignment adoption inserts only the assigned configured QC task once and is workspace-safe`; `requeue candidate SQL binds the stage array with a real PostgreSQL client`; `quota-failure lookup uses typed binds against PostgreSQL`; `PASS sweep SQL plans against the PostgreSQL test schema when qc_verdict is available`; and `Parked issue creates a diagnosis task against the PostgreSQL test DB`. Failure-name diff is empty; the latter five fail from the same unavailable local PostgreSQL endpoint.
- Step 16: Removed the temporary detached base-comparison worktree and the temporary read-only SQL input file after recording their verified outputs. Both were local run artifacts and are not part of the production fix.
- Step 17: Review detected that the shared branch advanced concurrently to commit `5dc536845` (`fix(belt): typed readvance must send current_work_product_md5`) and that commit is already present on `origin/belt/readvance-md5-20260909`; it contains the source and regression edits. Orchestrator inbox remained empty. Only the additional verified run log in `RESULT.md` remains uncommitted.
- Step 18: Verified GitHub PR #866 is open from `belt/readvance-md5-20260909` to `main` with the expected title. The implementation commit includes the source change, regression tests, and initial `RESULT.md` findings.
- Step 19: Committed and pushed the extended verification log as `1eaf650d7` to the open PR branch. Wrote the verified source/test/measurement facts to `sk brain` entry `1788926499-b869eb93`, then read `sk help report` before close reporting.
