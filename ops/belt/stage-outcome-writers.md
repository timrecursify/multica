## `issue_stage_outcome` writer trace

The typed worker-result writer is `ops/belt/stage-outcome.cjs:persistOutcome`;
it parses the task declaration and upserts the `(issue_id, stage)` row. The
upsert is guarded by the task's issue and `context->>'to_stage'`, so a task for
stage B cannot be attached to stage A. The relay-advance daemon's
`recordRefusedAdvance` only marks `relay_run_log` failed; relay refusal is not a
task outcome and cannot create `FAILED/human`. Its readvance path records denial
diagnostics in `relay_run_log.parked_audit` and leaves typed `ADVANCED`/`NO_OP`
rows unchanged. Explicit `OUTCOME: BLOCKED blocked_on=human` remains parsed and
routed by the existing completion route.

The historical stage mismatch occurred when the refusal path inserted a row for
`row.to_stage` while retaining `row.task_id` without checking that the task's
`context.to_stage` matched. The ownership predicate now fails closed. The
reported repair candidate is 81 rows (19 mismatched `ADVANCED`, 3 mismatched
`NO_OP`, 35 matched `ADVANCED`, 24 matched `NO_OP`); repairing those production
rows requires a separately reviewed, read-only-audited migration and is not
performed by this change.
