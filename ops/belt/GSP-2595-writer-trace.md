## Outcome writer trace

`issue_stage_outcome` has three production write paths:

- `ops/belt/stage-outcome.cjs:88-92` (`upsertOutcomeSql`) records the parsed
  worker declaration. `recordStageOutcomes` calls it at lines 265 and 269;
  this is the only writer allowed to turn a task result into ADVANCED, NO_OP,
  BLOCKED, or FAILED.
- `ops/belt/parity/multica-relay-advance-daemon.cjs:2340-2343`
  (`recordRefusedAdvance`) marks the relay log failed. It deliberately does
  not write `issue_stage_outcome`: a refused POST is transport telemetry, not
  a worker declaration.
- The typed readvance path updates `blocked_on` only for an independently
  verified QC SHA/human condition (`:2387-2390`); relay refusals and retry
  exhaustion are retained in `relay_run_log.parked_audit`.

The historical stage/task mismatch occurred when the refusal writer upserted
`row.task_id` under `row.to_stage` without checking the task's
`context->>'to_stage'`; a task completed for stage B could therefore be
attached to an outcome row for stage A. Readvance now requires matching issue
and stage ownership in its task join, and refuses to discover cross-stage
associations.

The reported repair candidate is 81 rows (19 mismatched ADVANCED, 3 mismatched
NO_OP, 35 matched ADVANCED, 24 matched NO_OP). Repair is intentionally
read-only in this change: a reviewed operator migration must first snapshot
those rows, verify each task declaration and stage, then restore the typed
outcome with `blocked_on = NULL`; no queue rows are mutated here.
