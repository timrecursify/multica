## GSP-2595 outcome writer trace

`issue_stage_outcome` has one normal writer and two historical relay writers.

* `ops/belt/stage-outcome.cjs:87-92` (`upsertOutcomeSql`) is the normal
  completion writer. `recordOneOutcome` parses the task output and writes the
  task's `context.to_stage`, typed outcome, blocker, and task id together.
* `ops/belt/parity/multica-relay-advance-daemon.cjs:2393-2395`
  (`recordRefusedAdvance`) records only refusal diagnostics in
  `relay_run_log`; it intentionally does not write stage outcomes.
* The retry/readvance path at
  `ops/belt/parity/multica-relay-advance-daemon.cjs:2400-2470` updates only
  `relay_run_log.parked_audit`. The QC return path at `:2518-2550` is the
  intentional writer of `FAILED` outcomes (including `blocked_on='human'`)
  after a bounce ceiling, an independently evidenced policy decision.

The former refusal implementation (removed in PR #812) inserted
`FAILED/human` while retaining the successful task id. A stage-A row could then
cite a stage-B task when an earlier completion association had already selected
the wrong `(issue, stage)` row; the retry upsert preserved that task id. The
ownership join in `readvanceRecordedOutcomes` (`:2410-2418`) now requires the
task issue and `context.to_stage` to equal the outcome row, so cross-stage
associations are ignored rather than rewritten.

The read-only candidate query is `ops/belt/gsp-2595-repair-report.sql`. It
re-parses each cited task's final typed declaration, partitions matched and
mismatched stages, and excludes unproven issue/task pairs. The reported 81 rows
(19 mismatched ADVANCED, 3 mismatched NO_OP, 35 matched ADVANCED, 24 matched
NO_OP) are candidates only; production repair must be a separately reviewed,
transactional, idempotent operation with rollback capture. No repair is run by
this change and `agent_task_queue` is never modified.
