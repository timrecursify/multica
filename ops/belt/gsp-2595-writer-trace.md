## GSP-2595 outcome-writer trace

Production writes to `issue_stage_outcome` are limited to the typed parser in
`ops/belt/stage-outcome.cjs:265-269` (normal completion upsert), the
`stage-outcome.cjs:397-405` retry/repair path, and the relay readvance daemon's
completion updates in `ops/belt/parity/multica-relay-advance-daemon.cjs`.
The former `recordRefusedAdvance` writer (the INSERT/UPSERT around lines
2340-2349 and its retry equivalent around 2402-2435) was the defect: a relay
4xx, mismatched 200, or exhausted retry rewrote the cited task as
`FAILED/human`. It now marks only `relay_run_log` diagnostics and leaves the
typed outcome unchanged.

The 22 stage-mismatch rows arose when an outcome row for stage A retained a
`task_id` selected from a different stage B. The old refusal upsert trusted
the row's stored stage and task id independently, so it preserved that
cross-stage association while changing the outcome. Readvance selection now
joins issue, task issue, and `task.context->>'to_stage'` to the outcome stage;
the association is rejected rather than overwritten.

The read-only report identifies 81 historical candidates (19 mismatched
`ADVANCED`, 3 mismatched `NO_OP`, 35 matched `ADVANCED`, 24 matched `NO_OP`).
`gsp-2595-repair-report.sql` is the reviewed partition query; no repair is
executed by this change. Any candidate whose issue, task, declaration, or
stage cannot be proven is excluded. `gsp-2595-repair.sql` is a separate,
transactional, idempotent, rollback-capturing step requiring explicit human
approval.
