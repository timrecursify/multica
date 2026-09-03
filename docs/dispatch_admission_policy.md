# Dispatch / Load Admission Gate (MINT-5)

## What it does
The admission gate limits concurrent ticket processing so a large QC or batch
ticket wave cannot overload the system, preventing the load events that cost
productivity on Aug-13. When configured, the dispatcher snapshots global
dispatch load on the enqueue path and **rejects** new work beyond the hard cap,
**defers** it with exponential backoff as load approaches the alert threshold,
and lets Ops **alert** before the cap is reached.

## How to enable
The gate is disabled by default. Enable it by setting at least one capacity cap:

```
MULTICA_DISPATCH_MAX_QUEUE_DEPTH=1000   # hard cap on globally queued tasks
MULTICA_DISPATCH_MAX_CONCURRENT=50      # hard cap on actively-worked tasks
MULTICA_DISPATCH_ALERT_THRESHOLD=0.8    # fraction of capacity that triggers defer + near-limit alert
MULTICA_DISPATCH_BACKOFF_BASE=1s        # starting exponential backoff for deferred work
MULTICA_DISPATCH_BACKOFF_CAP=30s        # maximum backoff a deferred task may reach
```

With only one cap set, that cap is authoritative; with both set, the smaller
(binding) cap governs the alert watermark. `ALERT_THRESHOLD` is clamped to
`[0,1]`; `0` disables the defer band and near-limit alert.

## Semantics
- **Admit** — load is below the alert watermark. The task is enqueued normally.
- **Defer** — load is at/above `ALERT_THRESHOLD` but below the hard cap. The
  task is held back with `Retry-After` = exponential backoff (base × 2^n,
  capped). Consecutive deferrals escalate; an admit or reject resets the chain.
- **Reject** — load is at/above the hard cap. The task is refused outright and
  is **not** retried immediately (retrying would only add pressure).

These decisions apply to the shared admission `dispatch.AdmissionPolicy`
evaluator in `server/internal/dispatch/admission.go`. It is a pure function,
unit-tested in isolation.

## Where it is enforced
The gate is consulted by the issue-minted enqueue paths in
`server/internal/service/task.go` (`enqueueIssueTaskWithCommentPlan` and
`enqueueMentionTaskWithCommentPlan`). It is opt-in per deployment through the
`TaskService.DispatchAdmission` policy (wired from env in
`server/cmd/server/main.go`). A nil/zero policy admits everything unchanged.

Admission classes (critical / standard / best-effort) feed the reason strings
and metrics labels; the hard caps and alert threshold are shared. Direct /
operator-triggered runs are classified critical so an overload cannot starve
the very actions meant to fix it.

## Monitored signals
The gate emits Prometheus counters under `multica_dispatch_admission_*`:

- `multica_dispatch_admission_admitted_total{class="..."}`
- `multica_dispatch_admission_deferred_total{class="..."}`
- `multica_dispatch_admission_rejected_total{class="..."}`
- `multica_dispatch_admission_near_limit_total{class="..."}`

Queue depth and running-task gauges already exist as
`multica_agent_task_queued` / `multica_agent_task_running` (sampled from the
DB). Alert when `near_limit_total` rises or the smaller-cap fraction of
`queued + running` crosses `ALERT_THRESHOLD`.

## Tuning
Start from the production gauges: set `MAX_QUEUE_DEPTH` / `MAX_CONCURRENT` a
little above the observed steady-state highs and rehearse a
10,000-ticket simulated wave in staging. Raise the caps if the wave reclaims
health while staying under the alert watermark; tighten them if latency or
load climbs before the cap.
