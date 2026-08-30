# Multica native execution path — GSP Tower

`gsp-noc2` has one flight execution path: PM2 process `gsp-multica-worker`
running the native Multica daemon, called the **Tower**. External board-polling
workers are retired and must not be recreated.

## Execution canon

Multica runs its own work. Flights move only through Multica-native workflows and
Multica-native agents:

- The Tower claims flights and dispatches them to agents recorded in Multica,
  writing `agent_task_queue`.
- Stage changes go through the relay bridge. SQL never changes issue status.
- Multica autopilots push the queue on their schedules.

Never add a process that reads the `issue` table and drives its own build loop.
That path is removed and must not return.

## Air-traffic-control terminology

Use these terms in documentation, comments, and reports. They name concepts, not
identifiers: never rename a table, column, PM2 app, or agent row to match them.

| Term | Meaning | Concrete thing |
| --- | --- | --- |
| Tower | The one authority that clears movement | Multica daemon, PM2 `gsp-multica-worker` |
| Flight | One unit of work | A Multica issue (ticket) |
| Flight plan | What the flight must achieve | The issue description and spec |
| Aircrew | The agents that fly builds | The 12 DeepSeek build agents |
| Approach Control | Clears a flight to land | The 5 QC agents |
| Ground | Moves flights between stages | Relay bridge, PM2 `gsp-multica-bridge` |
| Flow Control | Limits how many fly at once | Concurrency and load caps |
| Autopilot | Scheduled automation | `autopilot` and `autopilot_trigger` rows |
| Fuel | Model tokens and spend | OpenRouter and codex usage |
| Squawk 7700 | Emergency alert | Sentinel ticket |
| Field | A workspace | GSP Multica, PPP Production |

Stages read as a flight:

| Stage | ATC name |
| --- | --- |
| `Spec` | Filed |
| `Queue` | Holding |
| `In Progress` | Airborne |
| `In Review` | On approach |
| `CI/CD & Deploy` | Rollout |
| `Done` | At gate |
| `Cancelled` | Cancelled |

## Native handoff graph

| Relay transition | Native task owner | Runbook |
| --- | --- | --- |
| `Registered` to `Spec` | Sol-low agent | `RUNBOOK_SPEC_WORKER.md` |
| `Spec` to `Queue` | DeepSeek relay owner | `RUNBOOK_BUILD_WORKER.md` |
| `Queue` to `In Progress` | none | Current build task continues |
| `In Progress` to `In Review` | Sol-low agent | `RUNBOOK_QC_WORKER.md` |
| `In Review` to `Done` | none | Current QC task completes |

Ground writes each handoff to `agent_task_queue`. The Tower claims tasks for both
fields and injects a task-scoped token. Aircrew never poll issue stages.

## Live process

The wrapper is `/home/newadmin/gsp-multica/fleet/multica-daemon-wrapper.sh`.
It starts daemon ID `gsp-multica-worker` with the configured Flow Control cap
(`--max-concurrent-tasks`), 30-second heartbeat, two-second poll, and workspace
root `/home/newadmin/multica-workspaces-gsp`.

The wrapper uses the default Multica member profile because that credential is
a member of both GSP Multica and PPP Production. A workspace-scoped daemon
token cannot claim the other field and must not be used here.

## Persistent agents

Do not create agents for this path. Use the existing Aircrew, Approach Control,
and relay-owner rows. Agent instructions contain only the common and role
runbook paths.
