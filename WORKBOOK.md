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

## SCOPE consult — sk-cli deployment ownership, 2026-09-09

Decision: select the existing `receipt` protocol for `timrecursify/sk-cli`, target
`fleet-sk-cli`, deployment owner `sk-cli-release`. This is a contract decision,
not evidence that a sk-cli receipt producer is already deployed. For executable
changes, “deployed” means the owner has activated the exact source commit in its
declared fleet installation scope, verified that installed executable, and
published an exact schema-v1 activation/health receipt visible to this consumer.
Publishing a release or merging a PR alone does not establish installation.
Keep the existing docs-only exemption. Do not classify all sk-cli changes as
`no_deploy_target`: this worktree explicitly models an installed CLI target.

Evidence (all paths belong to this worktree):

- `ops/belt/multica-cicd-worker.cjs:29` declares `DEPLOY_TARGET_RULES`;
  `:34` assigns sk-cli `fleet-sk-cli` / `sk-cli-release`, currently `writer: null`.
- `ops/belt/RECEIPT_CONTRACT.md:19` requires the exact activated source SHA;
  `:24` requires activation and health before atomic publication; `:75` already
  names this sk-cli target and owner. This document describes the intended
  contract, not proof of an installed producer.
- `ops/belt/cicd-deploy-evidence.cjs:14` historically identifies sk deployment
  through `sk --version` plus merge ancestry; `:48` applies this to sk-cli.
  `ops/belt/cicd-deploy-evidence.test.cjs:5` covers that older predicate. It
  supports installation semantics but is weaker than the exact receipt contract
  and does not prove fleet-wide activation or health.
- `ops/belt/multica-cicd-worker.cjs:269` validates exact repository, target, owner,
  source, activation, and health; `:640` consumes receipts; `:658` emits auditable
  `activation_receipts` evidence. No new evidence format is necessary.
- `ops/belt/deploy.sh:271` is the existing atomic receipt writer example, invoked
  after successful activation and health at `:537` and `:557`. It deploys Multica
  belt units; it is not a sk-cli installer. `ops/belt/deploy.test.sh:330` checks its
  receipt, and `:337` checks that no-op/copy-only paths publish none.
- `ops/belt/multica-cicd-worker.cjs:606` handles `docs_only`; `:614` handles a
  declared empty target mapping; `:618` deliberately rejects absent writers.
  `ops/belt/multica-cicd-worker.test.cjs:667` currently checks sk-cli re-spec and
  `:679` excludes that terminal ownerless blocker from watchdog retries.
- PPP uses `deploy_marker` at `ops/belt/multica-cicd-worker.cjs:39` with ancestry
  verification covered at `ops/belt/multica-cicd-worker.test.cjs:636`. The inspected
  worktree does not identify a corresponding sk-cli marker producer or ref;
  selecting a made-up ref would not establish deployment ownership.

Minimal proposed Multica diff:

```diff
--- a/ops/belt/multica-cicd-worker.cjs
+++ b/ops/belt/multica-cicd-worker.cjs
@@
-    default: { target: 'fleet-sk-cli', owner: 'sk-cli-release', writer: null }, rules: []
+    default: { target: 'fleet-sk-cli', owner: 'sk-cli-release', writer: 'receipt' }, rules: []
```

Update the focused sk-cli regression to expect missing receipts to hold in
CI/CD & Deploy with `activation_receipt_missing`, and add exact valid receipt,
wrong source/owner/target, failed health, and docs-only cases using injected
dependencies. Preserve generic ownerless behavior and its watchdog regression.
Document the owner integration below in `ops/belt/RECEIPT_CONTRACT.md`. This
consult does not implement that diff or run production commands.

Required sk-cli follow-up (separate repository; not inspected or modified):

1. In `timrecursify/sk-cli`, identify the existing release/install owner that
   activates the CLI on the managed fleet; explicitly enumerate the machines or
   installation cohort covered by `fleet-sk-cli` before asserting fleet success.
   No exact workflow filename or installer command is evidenced here.
2. Extend that owner's successful activation path to verify the installed
   executable reports the exact full source SHA, run its existing non-mutating
   smoke/health probe, and atomically publish
   `${MULTICA_RECEIPT_ROOT}/timrecursify/sk-cli/fleet-sk-cli/${source_sha}.json`.
   Bind `schema_version: 1`, `repository: timrecursify/sk-cli`,
   `target: fleet-sk-cli`, `deployment_owner: sk-cli-release`, exact
   `source_sha`/`activation.process_sha`, immutable `activation.release`, valid
   activation/health timestamps, `activation.status: activated`,
   `health.status: ok`, and the actual `health.probe`. The publication location
   must be readable by this worker; a GitHub artifact alone is insufficient.
3. Test successful installation, source mismatch, failed installation/health,
   partial fleet success, and interrupted publication. None of the failed paths
   may publish a success receipt. Never fabricate an exact-SHA receipt from a
   newer binary merely because it contains an older merge.
4. Coordinate enabling the Multica mapping with producer availability. The
   one-line consumer change alone changes ownerless re-spec into pending receipt
   waits; it does not complete sk-cli deployment ownership or unblock Done.

Scope boundary: only repository files were inspected. No network discovery,
live executable invocation, `/opt` changes, external repository writes, or
production deployment was performed. Validation for this consult is source
inspection; production tests were not run.
