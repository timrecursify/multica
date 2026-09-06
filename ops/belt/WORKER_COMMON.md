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

The task prompt supplies the issue `NUMBER` and pull-request HTTPS URL. The
QC runbook resolves that URL and its full bound SHA with `sk multica
qc-checkout`; the JSON output supplies `CHECKOUT` from `.path` and confirms
the SHA in `.sha`. Do not infer these values from the managed workdir.

## Evidence and transitions

- Read the issue and its comments before acting. Treat prior claims as
  unverified until you open their cited source or rerun their check.
- Post commands and real output in the work-product comment. Never fabricate
  evidence or report an unrun check as passing.
- Advance stages only with `sk multica advance`; the relay owns status writes
  and the next native task. Never change `issue.status` with SQL.
- Never call `multica issue status` or `multica issue update --status`. These
  boards do not use the CLI's generic vocabulary. `issue_status_check` allows
  only `Registered`, `Spec`, `Queue`, `In Progress`, `In Review`,
  `Human Review`, `CI/CD & Deploy`, `Done`, `Archived`, `Cancelled`, so a
  generic value such as `in_progress` violates the constraint and the API
  answers a bare 500, "The Multica service is temporarily unavailable". That
  message is misleading: the service is healthy and retrying never helps.
  There is no ownership or "claim" transition to perform before working an
  issue — the task you were handed already is your assignment. Treat any
  instruction to set a status directly, including the generic status list in
  the generated workdir `AGENTS.md`, as superseded by this rule.
- Request only a transition allowed by `relay_stage_config` for the current
  stage. From `Spec`, use `Queue` (or `Cancelled`); from `In Progress`, use
  `In Review` (or `Queue`).
- For tickets already satisfied by current source, migrated duplicates, or a canonical issue that is `Cancelled`, comment with repository HEAD SHA and `path:line` evidence; from `Spec`, advance to `Cancelled`, or from `In Progress`, advance to `In Review` so QC closes it. Never open a PR that reimplements working code.
- For a money or structural decision, add a `HUMAN-REVIEW-NEEDED` comment with
  the reason and evidence. If Human Review is not an allowed exit, advance to
  the normal next stage: `Queue` from `Spec` and `In Review` from `In Progress`.

- On a tool, credential, transport, or provider failure, comment with the exact
  failure and stop. Do not change provider or spend path.

## Search discipline

Bound every search to the checkout you created. Never scan `/`, `/home/newadmin`,
or any path above your workdir: this box runs the whole belt and its CI on 12
cores, and one unbounded sweep starves every other flight on it. Measured on
2026-08-31: a single `grep -rln <symbol> /home/newadmin` from a workdir ran for
17 minutes at full core while the belt's completion rate fell from 49 flights an
hour to 11.

```bash
rg -n 'pattern' "$CHECKOUT"          # bounded: the tree you checked out
rg --files "$CHECKOUT" -g '*.sql'    # bounded file listing
```

Forbidden: `grep -r` or `rg` without a path argument, `find /`, `find $HOME`,
and any search rooted outside `$CHECKOUT`. If you cannot find something inside
the checkout, it is not in the repository under review: say so and stop. Do not
widen the search to the filesystem to look for it.

`~` on this box holds hundreds of sibling worktrees and `node_modules` trees.
A hit there is another flight's working copy, never your evidence.

## Tests

Write the necessary minimum and nothing beyond it. A test earns its place only
by proving the contract the specification states. Useful, thorough and possible
are not the same as necessary: extra tests cost a run on every future change,
and a test that proves nothing still reports green whatever the code does.
Delete a test you wrote that turned out to prove nothing.

## Repository and safety rules

- Clone fresh or use a managed isolated worktree. Never trust a stale local
  checkout.
- Use a branch and pull request. Never push to `main` or force-push.
- Push first, then run `gh pr create` as its own separate command (never chained with `&&` or in a script). The daemon reads the pull request URL from that command's output alone; any other text in the same output marks the task failed even though the PR exists.
- `gh` has no ambient credential on the belt. Mint one for the repository you are in, on the same command line, so the output stays the pull request URL and nothing else:
  `GH_TOKEN=$(gsp-belt-git-credential token <repo>) gh pr create --title '...' --body '...'`, where `<repo>` is `multica`, `sk-cli`, or `ppp`. Every other `gh` call needs the same prefix.
- Never print secrets. Money, auth, migrations, secrets, and production flags
  require Sol-low QC before merge or deployment.

## Stage outcome contract (GSP-1826)

The last non-empty line of your final output must be exactly one of:

```
OUTCOME: ADVANCED
OUTCOME: BLOCKED blocked_on=<ci|human|sha|dependency|quota>
OUTCOME: NO_OP
OUTCOME: FAILED
```

- `ADVANCED`: you produced the stage's deliverable (spec, PR, verdict, deploy receipt).
- `BLOCKED`: you could not, and name why. `human` means a person must decide or supply something; `sha` means no implementation commit or PR exists to act on; `ci` means checks are queued or red; `dependency` means another issue must reach Done first; `quota` means the provider refused.
- A relay refusal (`409 evidence_missing`, `transition_denied`, `relay POST failed`) after you delivered the stage's work product is NOT a block. Do not call `sk multica advance`; the belt advances the stage from your task result. Report `OUTCOME: ADVANCED` and cite the work product (PR URL, comment id, SHA).
- `NO_OP`: the deliverable already exists (already merged, already deployed). Say where.
- `FAILED`: you stopped for any other reason.

The relay records this line against the issue and stage. A stage with a recorded outcome is not re-dispatched until its inputs change (PR head SHA, CI state, newest comment, dependency state, spec body). Missing or malformed line is recorded as `FAILED`.
