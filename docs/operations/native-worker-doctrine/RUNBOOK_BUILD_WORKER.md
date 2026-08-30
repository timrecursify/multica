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
4. Commit, push the ticket branch, and open a pull request when code changed.
5. Post the work-product comment below.
6. Advance `Queue` to `in_progress`, then `in_progress` to `in_review`.

The `Queue` transition intentionally creates no second build task. The
`in_progress` transition queues the Sol-low QC task through the relay.

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
