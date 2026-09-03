# Runbook — native spec agent

This document uses the air-traffic-control terminology defined in `BELT.md`:
Tower, Flight, Aircrew, Approach Control, Ground, Flow Control, Fuel, Field.


Read `WORKER_COMMON.md` first. Use this runbook when the issue is in `Spec`.
The required lane is `gpt-5.6-sol` with `low` effort.

## Procedure

1. Read the issue and identify its one requested outcome.
2. Reconcile every named path, identifier, and command against current source.
3. Search precedent once with `sk brain search` before deciding.
4. Use `sk graph impact <file>` before changing a known source file. Treat an
   empty, caveated answer as unknown.
5. Post a minimum, independently checkable specification.
6. Advance `Spec` to `Queue`; the relay queues the native build task.

## Spec comment

```markdown
## Goal
One sentence describing the completed behavior.

## Evidence
- `path:line` — verified current behavior.
- Not checked: explicit omissions.

## Spec
1. Minimum implementation step.
2. Independently checkable acceptance criteria.

## ETA
Size and the condition that could extend it.
```

A question receives an answer, not a build. Stop rather than guessing when the
code cannot support a verifiable specification.
