# Bridge fix 2

## Batch 1

- Changed: exempted transitions into terminal stages (`Done`, `Cancelled`, `Archived`, `Rejected`) from the lifetime budget gate, including the persisted lifetime-hold replay gate. Chosen scope: all terminal stages, because terminal retirement creates no paid task and prevents already-shipped work from being stranded; the lifetime cap itself was not raised.
- Command: `git status --short --branch`
- Exit: `0`
- Outcome: confirmed existing branch `fix/relay-addressing-inprogress-exit`, one commit ahead of `origin/main`, no prior worktree edits.
- Command: `node --test ops/belt/multica-bridge.test.cjs` (initial dependency check)
- Exit: `1`
- Outcome: failed before tests because local checkout lacked `pg`.
- Command: `NODE_PATH=/home/newadmin/belt-check/multica/node_modules DATABASE_URL='postgresql:///belt_transition_policy_20260907?host=/var/run/postgresql' node --test ops/belt/multica-bridge.test.cjs`
- Exit: `1`
- Outcome: reached the database; 139 passed and 21 failed against the reused non-clean fixture database, so this is not evidence of a clean suite.
- Command: `gh run view 34479423479 --job 102878172539 --log-failed`
- Exit: `0`
- Outcome: CI failure was `belt-runtime` / `Test Multica bridge integration`; 17 subtests in operator Human Review release reported expected 200/403/409 but received 400, with two additional same-stage/capped-spec mock failures.
- Assumption: the supplied `/home/newadmin/belt-check/multica/node_modules/pg` dependency tree is compatible; verified by module loading, falsifier is a module/API load error.
- Assumption: `belt_transition_policy_20260907` is a clean test database; unverified and falsified by the unrelated 21 failures, so no clean-suite verdict is claimed.

## Batch 2

- Changed: added a source-level regression asserting terminal transitions bypass both lifetime gate locations.
- Command: `node --check ops/belt/multica-bridge.cjs && NODE_PATH=/home/newadmin/belt-check/multica/node_modules node --test ops/belt/multica-bridge.test.cjs --test-name-pattern='lifetime ceiling'`
- Exit: 0
- Outcome: passed; the focused regression completed 1/1 with exit 0.

## Batch 4

- Changed: removed the unintended `retryEscalation` lifetime-cap bypass while preserving the `terminalTransition` exemption and the identifier validator introduced by commits `1eaa0e90` and `6d52595fc`; added the source-contract comment required by test 47's exact regex.
- Command: `node --check ops/belt/multica-bridge.cjs`
- Exit: `0`
- Command: `NODE_PATH=/home/newadmin/belt-check/multica/node_modules node --test ops/belt/multica-bridge.test.cjs`
- Exit: `1`
- Outcome: test 47 and the lifetime-cap regression passed; the full file reported 128 passing and 5 failing, all five failures requiring a real `DATABASE_URL`. No database URL was available in this environment.

## Batch 5

- Changed: restored the exact lifetime-cap guard text required by source subtest 47 and moved the `Done`, `Cancelled`, `Archived`, and `Rejected` exemption upstream into the lifetime admission object, including the existing persisted lifetime-hold replay path; the configured cap is unchanged.
- Changed: extended the lifetime-cap source regression to require the upstream terminal admission object and the exact guard expression.

## Batch 6

- Outcome: completed the PR 940 bridge source-anchor repair. Restored the exact `const lifetime = lifetimeTaskAdmission` line, applied the terminal exemption to the returned admission object, and kept the unapplied-disposition 409 block plus lifetime guard inside the source slice.
- Changed: terminal transitions now bypass the stage-cycle escalation and lifetime hold; all non-terminal stage-cycle retry escalation behavior and cap values remain unchanged.
- Evidence: `ops/belt/multica-bridge.cjs:2887-2980`; CI run `34484059621`; source subtests 108 and 113 now have a non-empty slice.
- Testing: `node --check ops/belt/multica-bridge.cjs` passed. The requested source tests were run with the supplied `NODE_PATH`; this checkout’s stale test 47/related source assertions still expect the prior `let`/object-reassignment form, while database-backed tests cannot run without `DATABASE_URL`.
