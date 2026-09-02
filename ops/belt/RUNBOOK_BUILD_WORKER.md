# Runbook — native build agent

This document uses the air-traffic-control terminology defined in `BELT.md`:
Tower, Flight, Aircrew, Approach Control, Ground, Flow Control, Fuel, Field.


Read `WORKER_COMMON.md` first. Use this runbook when the issue is in `Queue`.

## Lane

The agent row must specify:

- model `deepseek/deepseek-v4-flash-0731`;
- custom arguments `["-c", "model_provider=openrouter"]`.

Do not select a different provider or model. A 402 response is a money blocker;
comment with the error and stop.

## Procedure

1. Read the issue and comments. Identify the single requested outcome.
2. Implement the minimum change in a fresh clone or managed worktree.
3. Run the narrowest check that proves the acceptance criteria.
4. Commit, push the ticket branch, and open a pull request when code changed. Resolve the
   remote PR head and require it to be one reachable lowercase 40-character SHA equal to
   the local pushed commit. Before advancing, record both values in one transaction:
   `multica issue metadata implementation-evidence "$NUMBER" --pr-url "$PR_URL" --bound-sha "$SHA"`.
   A missing, mismatched, or unreachable ref is a blocked build and must not advance. For
   no-code work, record `NO-SHA` in the comment and create no implementation metadata.
5. Post the work-product comment below.
6. Advance `Queue` to `In Progress`, then `In Progress` to `In Review`, with
   `sk multica advance "$NUMBER" --to "In Progress" --board "$BOARD"`.

Write the stage names exactly as shown, capitals and space included. They are
the only values `issue_status_check` accepts. A generic form such as
`in_progress` violates the constraint and the API answers a bare 500, "The
Multica service is temporarily unavailable", which reads like an outage but is
not one: retrying never helps. See the status rule in `WORKER_COMMON.md`.

The `Queue` transition intentionally creates no second build task. The
`In Progress` transition queues the Sol-low QC task through the relay.

## Tests

Write the necessary minimum and nothing beyond it.

- Add a test only when it proves the acceptance criteria the specification
  states. One test that proves them is the target.
- Do not add a second test that proves the same thing with different inputs.
- Do not add coverage for behavior this flight did not change.
- If an existing test already proves the acceptance criteria, add none and say
  so in the work-product comment.
- Delete a test you wrote that turned out to prove nothing.

A test that proves nothing is worse than no test: it still has to be run, read
and maintained by everyone who comes after you, and it reports green whatever
the code does.

## Work-product comment

```markdown
## What changed
One sentence describing the observable outcome.

## Implementation
- `path:line` — behavior changed.

## Verification
$ command
real output

## Result
List each acceptance criterion as met or not met.
```

For a no-code operational test, state `NO-SHA`, run only the requested bounded
check, and do not invent a repository change.
