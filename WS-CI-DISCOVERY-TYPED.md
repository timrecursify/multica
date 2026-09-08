# GSP-2671 CI discovery typed result

Outcome: implemented and verified in this worktree.

## Findings

- Observed: before the change, `ops/belt/multica-cicd-worker.cjs:801-805` caught every CI discovery exception, logged it, and returned the string `unknown`.
- Observed: before the change, `ops/belt/multica-cicd-worker.cjs:897-903` counted that value as non-failing and continued after logging a hold; no watchdog call was made on that branch.
- Observed: `unknown` therefore represented any discovery exception: authentication/authorization, transport/network, rate-limit/cooldown, malformed output, or other `gh` failure. It did not represent genuine absent CI or pending CI; those had separate values.
- Inferred: the ambiguity allowed an infrastructure outage to remain an unaged hold.

## New control flow

- Observed: `ciState()` retains existing string results for `green`, `pending`, `absent`, `no_checks`, `cancelled_only`, `red`, and `mixed`.
- Observed: discovery exceptions now return `{ kind: 'infrastructure_failure', status: 'discovery_auth_failure' | 'discovery_transport_failure', cause: { name, message } }`.
- Observed: merged-PR handling at `ops/belt/multica-cicd-worker.cjs:607-612` returns a pending typed blocker without returning the accepted work product; `closureWatchdog()` at `:664-683` observes it and routes a stalled infrastructure repair to Human Review.
- Observed: open-PR sweep handling at `:906-912` sends the same typed result through `closureWatchdog()`, so the age check remains reachable.
- Observed: `ops/belt/cicd-watchdog.cjs:27-50` supports non-attempt observations. Infrastructure observations persist the durable row and age but do not increment implementation attempts.
- Observed: `watchdogFailure()` now marks acknowledged only after the escalation relay resolves (`:309-318`).

## Tests

Command: `timeout 300s node --test ops/belt/multica-cicd-worker.test.cjs`

- Before: 43 pass, 2 fail (the changed expectations exposed the old bypass and old untyped result).
- After: 47 pass, 0 fail, 0 skipped.
- Observed: tests cover authorization versus transport typing, unchanged absent and pending behavior, watchdog reachability, relay rejection without acknowledgement, and existing success paths.
- Inferred: accepted-product survival is shown by the absence of return/build relay calls in the merged discovery-failure test; no implementation budget is consumed by the non-attempt watchdog observation.

## Delivery

- Observed: draft PR #848 was created at https://github.com/timrecursify/multica/pull/848 from commit `dd3f6c875`.
- Observed: the requested external path `~/dev/seat/results/20260908_WS-CI-DISCOVERY-TYPED.md` was not written because the explicit write scope limits changes to this worktree. This report is the worktree-local equivalent.
- Observed: no deployment, restart, install, clone, benchmark, full-repo suite, or production worker access was performed.
- Observed: `DATABASE_URL` and `pg` were not needed by the executed unit suite.
