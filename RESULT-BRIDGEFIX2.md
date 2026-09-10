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
