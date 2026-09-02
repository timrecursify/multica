# Belt runtime mirror

This directory mirrors the current GSP belt runtime. The runtime paths below
are authoritative today. Editing a repository copy does not change running
behavior until it is deployed with `./deploy.sh --apply`.

Explicit terminal exits require `RELAY_OPERATOR_SECRET` in the bridge
environment and the matching `X-Relay-Operator-Secret` request header. If the
environment variable is unset, those exceptional exits are refused.

## Runtime map

| Repository file | Runtime path | Current runner |
| --- | --- | --- |
| `multica-bridge.cjs` | `/home/newadmin/gsp-multica/multica-bridge.cjs` | PM2 app `gsp-multica-bridge` |
| `guardrails.cjs` | `/home/newadmin/gsp-multica/guardrails.cjs` | Required by bridge and relay daemon |
| `parity/multica-relay-advance-daemon.cjs` | `/home/newadmin/gsp-multica/parity/multica-relay-advance-daemon.cjs` | PM2 app `multica-relay-advance`, through its wrapper and launcher |
| `multica-cicd-worker.cjs` | `/home/newadmin/multica-cicd-worker.cjs` | PM2 app `multica-cicd-worker` |
| `belt-config-guard.sh` | `/home/newadmin/tools/belt-config-guard.sh` | `belt-config-guard.timer`, which activates `belt-config-guard.service` |

To intentionally hold the AI worker during spend investigations or guarded
deploys, create `/home/newadmin/.local/state/multica-ai-hold`. The guard then
skips only `gsp-multica-worker`; bridge, CI/CD, archiver, and relay liveness
checks continue. Remove the marker only after the worker may safely resume.
| `multica-bundle.py` | `/home/newadmin/tools/multica-bundle.py` | No always-running PM2 app or systemd unit; the runbook invokes it with `python3` |
| `RUNBOOK_SPEC_WORKER.md` | `/home/newadmin/multica-doctrine/RUNBOOK_SPEC_WORKER.md` | No process; this is the operational runbook |

The current process inventory, quoted from `pm2 ls`, includes:

```text
gsp-multica-bridge       online
multica-cicd-worker      online
multica-relay-advance    online
```

The current timer inventory, quoted from
`systemctl list-timers 'belt-config-guard*'`, includes:

```text
UNIT                    ACTIVATES
belt-config-guard.timer belt-config-guard.service
```

`multica-relay-advance` is a PM2 wrapper process; its launcher invokes the
runtime daemon path shown above. The runbook currently names the bundle command
as `python3 /home/newadmin/tools/multica-bundle.py`.

## Deploy and verify

`./deploy.sh` is dry-run by default. It requires an explicit full immutable
commit: `./deploy.sh --dry-run --source-commit <40-char-commit>`. Use
`./deploy.sh --apply --source-commit <40-char-commit>` only when an operator
has approved changing the live runtime. It archives that exact commit into
private staging before it preflights every file,
creates all backups before copying, and restores touched targets on a partial
failure. A successful apply prints `./deploy.sh --rollback <UTC timestamp>`;
that command restores the matching backup set. No process is restarted.

`./verify.sh <40-char-commit>` compares runtime files only with blobs staged
from that commit and exits non-zero when any file is missing or differs.
Source resolution, checkout, or pull failures are terminal: do not copy files
or restart a process after any such failure.

## Parked-ticket diagnosis backfill

Run from a checkout with `DATABASE_URL` set. Preview first, then choose an
explicit apply run; each invocation handles at most 25 eligible tickets and
examines at most 100 candidates in workspace-round-robin order:

```bash
node ops/belt/backfill-parked-diagnosis.cjs --dry-run
node ops/belt/backfill-parked-diagnosis.cjs --apply --batch-size 25
```

An operator may make one explicit correction retry only for a completed
diagnosis held with `parked_blocker: runtime_evidence_unverified`:

```bash
node ops/belt/backfill-parked-diagnosis.cjs --apply --retry-runtime-evidence
```

The correction task must cite one exact durable reference as
`runtime_evidence: task:<uuid>`, `qc:<uuid>`, or `activity:<uuid>`. The retry
is recorded in task context and is never automatically repeated.

Add `--workspace <UUID>` to constrain a run. The script locks each still-Parked
issue, skips named blockers and all prior diagnosis tasks (reporting completed,
failed, and cancelled statuses), and emits stable JSON counts and IDs,
including stale rows that changed before the lock. Each apply candidate has its
own transaction: a policy rejection is rolled back, included in `counts.failed`
and `ids.failed`, and does not prevent later candidates or the final receipt.
It is an operator one-shot and is not part of the runtime deploy manifest;
rollback is a no-op because dry-run performs no writes and apply writes only the
ticket comment, blocker metadata, and diagnosis task.

## Runtime-evidence verification lane

The relay also performs a bounded, deterministic verification pass for only
`Parked` tickets held by the exact `runtime_evidence_unverified` blocker after
an `already_fixed` diagnosis. It does not call a model or enqueue a diagnosis.
It accepts only a same-issue durable `task:`, `qc:`, or `activity:` reference;
missing or malformed evidence remains Parked with a named blocker. A verified
PASS hash follows the terminal relay route; otherwise it is released to `In Review`
with `runtime_evidence_verified:<reference>` for QC.

Preview the same cohort without writes, then use explicit apply (both default
to 25 and may be constrained to one workspace):

```bash
node ops/belt/backfill-parked-runtime-verification.cjs --dry-run --workspace <UUID>
node ops/belt/backfill-parked-runtime-verification.cjs --apply --workspace <UUID>
```
