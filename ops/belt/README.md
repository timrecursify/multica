# Belt runtime mirror

This directory mirrors the current GSP belt runtime. The runtime paths below
are authoritative today. Editing a repository copy does not change running
behavior until it is deployed with `./deploy.sh --apply`.

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

`./deploy.sh` is dry-run by default. Use `./deploy.sh --apply` only when an
operator has approved changing the live runtime. It preflights every file,
creates all backups before copying, and restores touched targets on a partial
failure. A successful apply prints `./deploy.sh --rollback <UTC timestamp>`;
that command restores the matching backup set. No process is restarted.

`./verify.sh` compares every repository copy with its runtime path and exits
non-zero when any file is missing or differs.

## Parked-ticket diagnosis backfill

Run from a checkout with `DATABASE_URL` set. Preview first, then choose an
explicit apply run; each invocation handles at most 25 tickets:

```bash
node ops/belt/backfill-parked-diagnosis.cjs --dry-run
node ops/belt/backfill-parked-diagnosis.cjs --apply --batch-size 25
```

Add `--workspace <UUID>` to constrain a run. The script locks each still-Parked
issue, skips named blockers and nonterminal diagnosis tasks, and emits stable
JSON counts and IDs. It is an operator one-shot and is not part of the runtime
deploy manifest; rollback is a no-op because dry-run performs no writes and
apply writes only the ticket comment, blocker metadata, and diagnosis task.
