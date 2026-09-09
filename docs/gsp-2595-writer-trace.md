## GSP-2595 outcome writer trace

Production writes to `issue_stage_outcome` are centralized in
`ops/belt/stage-outcome.cjs:88-92` (`upsertOutcomeSql`, called by
`persistOutcome` at :257), which parses the task declaration and preserves an
explicit `BLOCKED` reason. Relay advancement (`ops/belt/parity/
multica-relay-advance-daemon.cjs:2340-2344`) now records refusal only in
`relay_run_log`; it does not manufacture `FAILED/human`. Readvance retry
diagnostics are likewise written to `relay_run_log` at :2408-2417.

Historical stage/task mismatches occurred when the refusal upsert used the
requested relay stage while retaining a task id whose `context.to_stage` came
from a different completion. `persistOutcome` now checks the task's issue and
`context.to_stage` before writing and rejects a proven mismatch, preventing
cross-stage ownership.

The reported 81 rows (19 mismatched ADVANCED, 3 mismatched NO_OP, 35 matched
ADVANCED, 24 matched NO_OP) are repair candidates only. Repair must be a
separate, reviewed, transactional, idempotent read-only report followed by
human-approved execution; no implementation or runtime task queue mutation is
performed here.
