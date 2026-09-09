# Attempt-budget exhaustion disposition

## Batch 1 — baseline and root-cause verification

- Base: `origin/main` at `55a533519563b7f0a1de83dbbb6de2db631cb294`.
- Verified `stageEligibility()` returns `{ eligible: false, reason: "attempt_budget_exhausted" }` from its first guard without loading or returning `prior`.
- Verified `reconcileIssue()` passes that absent `prior` to `routeTerminalBlocker()`, then returns a bare skipped result when no disposition is produced.
- Verified the adjacent lifetime-cap path calls `deferMechanicalRetry()` with `options.mechanicalRetryMinutes`.
- Verified `stageEntryWindowSql()` includes `mechanical_retry_release_at` in the attempt-count lower bound.
- Baseline command: `node --test ops/belt/reconciler.test.cjs`.
- Baseline result: 40 tests; 38 passed, 2 failed. Both failures require an unset `DATABASE_URL`; all non-database tests passed.

## Batch 2 — implementation and focused regressions

- Added a narrow `attempt_budget_exhausted` fallback after terminal-blocker routing produces no disposition. It records `attempt_budget_exhausted:<attempt>/<max>` through the existing mechanical deferral using the unchanged `options.mechanicalRetryMinutes`.
- Added regressions for timed deferral/no Human Review accounting, automatic release into a fresh stage-entry window, and unchanged behavior for another typed-outcome ineligibility.
- First focused run: 43 tests; 40 passed, 3 failed. Two failures match the baseline `DATABASE_URL` requirement; one new test-harness assertion failed because its intercepted attempt query was not recorded. The production change passed its direct regression.

## Batch 3 — corrected harness and verification

- Corrected the stateful release-window test harness so its intercepted stage-attempt query remains available for SQL-boundary assertions.
- Focused result: 43 tests; 41 passed, 2 failed. The two failures are identical to baseline and require `DATABASE_URL`; all three added regressions pass.
- `git diff --check`, `node --check ops/belt/reconciler.cjs`, and `node --check ops/belt/reconciler.test.cjs` pass.

## Batch 4 — delivery

- Commit: `7cd86f8d8` (`fix(belt): defer exhausted stage attempts`).
- Opened PR [#877](https://github.com/timrecursify/multica/pull/877) from `fix/attempt-budget-deferral` to `main`.
- No deployment, merge, configuration edit, database edit, or credential operation was performed.
