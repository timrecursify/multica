# Stage outcome writer trace (GSP-2595)

`issue_stage_outcome` has three production write paths. `ops/belt/stage-outcome.cjs:88-92`
upserts the parsed completion for the task's own `context.to_stage`; this is the
authoritative writer. `ops/belt/parity/multica-relay-advance-daemon.cjs:2340-2344`
and `:2402-2435` handle relay refusals/readvance diagnostics and must not rewrite a
successful task as `FAILED/human` (refusal details are retained in `relay_run_log`).
The reconciler at `ops/belt/reconciler.cjs:273-275` only routes an already-recorded
`FAILED/human` row and is not a writer.

Historically, a row for stage A could cite a task for stage B when the refusal path
upserted using `row.to_stage` while retaining `row.task_id`; the task selector and
outcome row therefore disagreed. The ownership rule is that `task_id` belongs only
to the same issue and `agent_task_queue.context->>'to_stage'` as the outcome row.

The reported repair candidate set is 81 rows (19 mismatched ADVANCED, 3 mismatched
NO_OP, 35 matched ADVANCED, 24 matched NO_OP). No production repair is executed by
this change; a separate human-reviewed, transactional, idempotent repair must
re-parse each cited task and exclude unproven rows, with before/after counts and
rollback capture.
