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

1. Read the issue, the relay-provided `scope_revision`, and the explicitly active work
   product. Comments are context only; a pull request or SHA mentioned in prose never owns
   the work.
2. For rework of the same scope revision, reuse the active work product's branch and pull
   request. Update that branch and exact head SHA; never open a second pull request. For a
   new scope revision, record which prior revision it replaces before creating new work.
3. Implement the minimum change in a fresh clone or managed worktree. The consuming stage
   owns merge, rebase, and disposition decisions; the builder never self-merges or closes a
   pull request independently.
4. Run the narrowest check that proves the acceptance criteria.
5. For implementation work, commit and push the canonical branch, opening a pull request
   only when no active implementation product exists for this scope revision. Resolve the
   remote head and require one reachable lowercase 40-character SHA equal to the pushed
   commit. The structured handoff must atomically record kind, repository, branch, PR
   number, exact head SHA, acceptance evidence, replacement revision, declared dependency
   issue IDs, and consuming stage. A missing or mismatched field is blocked evidence.
6. For no-change or operational work, record kind plus independently verified acceptance
   evidence and `NO-SHA`, with no repository, branch, or PR fields. Never manufacture a
   test edit merely to create a diff.
7. Post the human-readable work-product comment below. It is an audit view, not the
   ownership record.
8. Advance `Queue` to `In Progress`, then `In Progress` to `In Review`, with
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

For a no-change or operational result, state `NO-SHA`, include the exact command,
timestamp, and observed output that verify acceptance, and do not invent a repository
change.
