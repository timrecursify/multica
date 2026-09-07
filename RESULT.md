Outcome: centralized repeatable belt gate reads by repository/SHA, removed synchronous subprocesses from relay/QC/CICD reads, added durable issue/SHA claims and bounded gate workers, and preserved the rebased activation-receipt contract; deployment remains supervisor-owned.

# Repeated-work inventory

Production snapshot: 2026-09-07 15:13:59 UTC. Counts marked `lower bound` are the strongest value recoverable because the old processes did not record endpoint-level invocation counts; the new advance metrics make those counts exact after deployment.

| repeated operation | call site | last-hour executions | result scope | central disposition |
|---|---|---:|---|---|
| Completed-task evidence/admission reads | `ops/belt/parity/multica-relay-advance-daemon.cjs:1250-1274` | 146 completed tasks (DB exact) | per task/issue | Keep per-ticket admission; fair `created_at,id` selection and a bounded worker consume the batch. |
| PR pointer discovery from normalized link, comments, then task result | `ops/belt/qc-gate.cjs:53-64`; `ops/belt/multica-cicd-worker.cjs:825-842` | 33 persisted gates across 23 issues; 2 CI/CD exits (DB exact outcomes, lookup calls unlogged) | per issue | Not shareable; remains an issue-scoped DB read. |
| PR state, branch/head existence, mergeability | `ops/belt/qc-gate.cjs:73-75`; `ops/belt/parity/multica-relay-advance-daemon.cjs:260-289`; `ops/belt/multica-cicd-worker.cjs:850-859` | at least 33 gate reads; CICD polling beyond 2 exits was unlogged | repository + PR, yielding SHA | Shared TTL/in-flight cache; no ticket key. SHA-derived reads use repository+SHA. |
| Check runs and combined commit status | `ops/belt/qc-gate.cjs:76-88`; `ops/belt/parity/multica-relay-advance-daemon.cjs:227-241`; `ops/belt/multica-cicd-worker.cjs:778-801` | at least 33 gate reads; exact endpoint count unlogged | repository + SHA | One in-flight/TTL read per repository+SHA+endpoint. QC check-runs and files start concurrently. |
| PR changed-file manifest and risk/scope scan | `ops/belt/qc-gate.cjs:76-106`; `ops/belt/parity/multica-relay-advance-daemon.cjs:284-287`; `ops/belt/multica-cicd-worker.cjs:44-49,74-81` | at least 33 gate manifests; CICD calls unlogged | repository + SHA | Shared repository/SHA cache; activation-receipt target selection from the landed upstream work remains authoritative. |
| Source-file content reads for size checks | `ops/belt/qc-gate.cjs:94-104` | file-dependent; old code recorded no count | repository + SHA + path | Shared TTL/in-flight cache keyed by repository+SHA+path. |
| Git tree hashing and fetch-on-miss | `ops/belt/qc-gate.cjs:31-51` | up to 33 persisted gate runs; fetch misses unlogged | repository + SHA | Async subprocess; one cached tree digest per repository+SHA. Clone/store work remains owned by ALPHA-000372. |
| GitHub credential mint and rate-limit state | `ops/belt/parity/multica-relay-advance-daemon.cjs:179-220`; `ops/belt/github-api-adapter.cjs:34-61,95-149`; `ops/belt/multica-cicd-worker.cjs:91-189` | old calls unlogged; formerly repeated with GitHub reads | credential, token repository-scoped | Token fetch is TTL/in-flight cached per repository; one file-backed cooldown budget is shared under credential scope. |
| CICD action runs, workflows, jobs, and comparisons | `ops/belt/multica-cicd-worker.cjs:366-456,778-801` | 2 CI/CD→Done transitions; poll/read count unlogged; 0 tickets present at snapshot | repository + SHA/run | Async command path with repository/SHA TTL/in-flight reads. Mutating reruns bypass cache. |
| Activation receipt reads | `ops/belt/multica-cicd-worker.cjs:309-320,541-579` | 2 CI/CD→Done transitions; receipt count depends on required targets and was unlogged | repository + target + SHA | Per-SHA/target and shareable, but deliberately not changed: ALPHA-000363 owns deploy-evidence/receipt logic and the rebased receipt contract must remain authoritative. |
| Merge call | `ops/belt/multica-cicd-worker.cjs:936-939` | 0 current merge candidates at snapshot; last-hour attempts unlogged | repository + PR | Never cached; serialized per repository and idempotency remains GitHub/relay enforced. |
| Workspace validation/preparation and repository metadata | `ops/belt/multica-daemon-wrapper.sh:63,126-136` | 163 task starts and 136 distinct work dirs (DB exact); individual filesystem operations unlogged | workspace/repository, then task workdir | Inventory only: dependency, clone, store and workspace IO are owned by ALPHA-000372; its `RESULT.md` was absent when checked. |
| Static prompt/runbook assembly | daemon launched at `ops/belt/multica-daemon-wrapper.sh:126-136`; runbooks are `ops/belt/RUNBOOK_*_WORKER.md` and `WORKER_COMMON.md` | 163 task starts (DB exact opportunities; one assembly per start inferred) | stage/workspace, with per-ticket payload | Installed daemon implementation is outside this repository source. Static assembly is shareable upstream; ticket content is not. |

# Implementation and correctness

- `GATE_CHECK_CONCURRENCY` defaults to `1`, the former effective sequential value; invalid values also fail back to `1` (`ops/belt/parity/multica-relay-advance-daemon.cjs:48-55`). This is separate from model/QC concurrency.
- The advance batch uses fair ordering, bounded workers and exact per-pass metrics (`ops/belt/parity/multica-relay-advance-daemon.cjs:1250-1299`).
- A single atomic statement claims both the issue/SHA and its relay row, with no transaction held over GitHub/git calls; the claim and retry eligibility survive process loss and expire using the existing QC pending-recheck interval (`ops/belt/parity/multica-relay-advance-daemon.cjs:1104-1155`).
- Transient external failures persist retry eligibility instead of failing the relay row (`ops/belt/parity/multica-relay-advance-daemon.cjs:1240-1246`).
- CICD merges stay serialized per repository while unrelated repositories remain independent (`ops/belt/multica-cicd-worker.cjs:194-200,919-921`).
- Rebase onto `origin/main` preserved the activation-receipt contract from upstream and converted only its changed-path GitHub read to async; workflow success still cannot substitute for activation evidence (`ops/belt/multica-cicd-worker.cjs:44-49,541-579`).

# Measurement and proof

| measure | before | after |
|---|---:|---:|
| Production advance duration | greater than the 15,000 ms cadence (provided observation; old PM2 logs were unavailable through `sk`) | pending supervisor deployment; every pass will emit `duration_ms` at `ops/belt/parity/multica-relay-advance-daemon.cjs:1294-1299` |
| Production external calls/pass | uninstrumented | pending supervisor deployment; every pass will emit `external_calls` and `cache_hits` at the same call site |
| Synthetic six independent 30 ms gates | 182 ms sequential | 61 ms at gate concurrency 3 |
| Synthetic six identical repository/SHA reads | 6 loader calls without sharing | 1 external load + 5 in-flight hits |

Verification:

- 79/79 targeted adapter, QC gate, CICD worker/sweep, and reconciler tests passed after rebasing.
- 9/9 unattended-lifecycle checks passed after updating the harness to await the asynchronous CI/CD API.
- Relay concurrency/claim assertions passed 8/8 with an injected `pg` boundary. The full relay suite could not load because this checkout has no `pg` module; dependency installation was not duplicated because ALPHA-000372 owns it.
- Slow-worker/heartbeat isolation is covered at `ops/belt/parity/multica-relay-advance-daemon.test.cjs:1575-1587`; atomic claims at `:1590-1600`; TTL/in-flight collapse at `ops/belt/github-api-adapter.test.cjs:75-97`; async QC fan-out at `ops/belt/qc-gate.test.cjs:8-47`; merge serialization at `ops/belt/multica-cicd-worker.test.cjs:764-779`.
- `iostat -x 1 2` verified the bottleneck during this lane: the live one-second sample had 19.98% CPU idle, 54.53% iowait, `sda` 83.40% utilized, and 13.01 ms write await.
- Production DB was read only. At the snapshot it showed 168 task creations, 163 starts, 146 completions, 33 QC-gate comments across 23 issues, and 42 tickets across Spec/Queue/In Progress/In Review.
- No deploy, restart, credential rotation, PPP-23686 access, or Multica ticket occurred.

Implementation commit: `14b603d34e6db06152f3de4cc5d5ed0b43fe3da0`

PR: https://github.com/timrecursify/multica/pull/785
