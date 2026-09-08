# Multica native worker doctrine — common

Binding for every Multica agent executed by `gsp-multica-worker`. Read this
file once, then read the runbook selected by the issue's current stage.

## Execution contract

- The native Multica daemon is the only ticket executor on `gsp-noc2`.
- Work only the issue supplied in the native `agent_task_queue` task.
- Never poll the board, create a standing loop, or create another worker.
- Never insert, update, requeue, or cancel `agent_task_queue` rows with SQL.
- Doctrine stays in these files. Agent database rows contain file references,
  not copies of doctrine.

## Workspace routing

Use `MULTICA_WORKSPACE_ID` as the authority for the board:

| Workspace ID | Board |
| --- | --- |
| `f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f` | `gsp` |
| `da3c5c5c-a123-4567-b999-c3ed1820da00` | `prod` |

Stop if the value is missing or different. Ticket numbers are not unique
across workspaces. Pass the selected `--board` on every `sk multica` command.

## Evidence and transitions

- Read the issue and its comments before acting. Treat prior claims as
  unverified until you open their cited source or rerun their check.
- Post commands and real output in the work-product comment. Never fabricate
  evidence or report an unrun check as passing.
- Advance stages only with `sk multica advance`; the relay owns status writes
  and the next native task. Never change `issue.status` with SQL.
- On a tool, credential, transport, or provider failure, comment with the exact
  failure and stop. Do not change provider or spend path.

## Repository and safety rules

- Clone fresh or use a managed isolated worktree. Never trust a stale local
  checkout.
- Use a branch and pull request. Never push to `main` or force-push.
- Never print secrets. Money, auth, migrations, secrets, and production flags
  require Sol-low QC before merge or deployment.
