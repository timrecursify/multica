## GSP-2595 outcome-writer trace

Production writes to `issue_stage_outcome` are limited to the typed parser in
`ops/belt/stage-outcome.cjs:265-269` (normal completion upsert), the retry
path at `stage-outcome.cjs:397-405`, and completion updates in
`ops/belt/parity/multica-relay-advance-daemon.cjs`. The former
`recordRefusedAdvance` INSERT/UPSERT (around lines 2340-2349 and its retry
equivalent around 2402-2435) was the defect: relay 4xx, mismatched 200, or
retry exhaustion rewrote a cited task as `FAILED/human`. It now records only
`relay_run_log` diagnostics and leaves the typed outcome authoritative.

The 22 stage-mismatch rows arose when a row for stage A retained a `task_id`
selected from stage B. The old refusal path trusted stored stage and task id
independently, preserving the cross-stage association while changing outcome.
Readvance selection now joins issue, task issue, and
`task.context->>'to_stage'` to the outcome stage, rejecting the association.

The read-only report partitions 81 historical candidates (19 mismatched
`ADVANCED`, 3 mismatched `NO_OP`, 35 matched `ADVANCED`, 24 matched `NO_OP`).
`gsp-2595-repair-report.sql` is the reviewed partition query; no repair runs in
this change. `gsp-2595-repair.sql` is a separate transactional,
rollback-capturing step requiring explicit human approval.
