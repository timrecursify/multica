# Bridge fix report

## Step 1 — investigation (2026-09-10)

- Verified `ops/belt/multica-bridge.cjs` queried `issue.id = $1` before this change, allowing decimal ticket numbers to reach a UUID parameter.
- Verified the existing `Parked` path retires only unstarted work, records a dedicated relay audit, and performs no dispatch; this is the preserving partial-work disposition.
- Verified no deployment or credential rotation was performed.

## Step 2 — implementation (2026-09-10)

- Added UUID/decimal identifier validation; decimal lookup requires a UUID `workspace_id`, and identifier failures return HTTP 400 with `invalid_issue_identifier` and an `identifier_shape`.
- Added explicit `partial_work_exit` validation for a reasoned `In Progress -> Parked` preserving exit; it uses the existing evidence-preserving Parked path and does not grant operator authority.

## Verification (2026-09-10)

`node --check ops/belt/multica-bridge.cjs`

```text
(no output; exit 0)
```

`git diff --check`

```text
(no output; exit 0)
```

`node --test ops/belt/multica-bridge.test.cjs`

```text
Error: Cannot find module 'pg'
Node.js v22.23.2
```

The test suite could not collect because the worktree has no `pg` module.

## PR handoff (2026-09-10)

The first PR creation attempt failed because the local branch had not yet been pushed (`Head sha can't be blank...`). No deployment was attempted.
