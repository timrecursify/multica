# Belt runtime mirror

This directory mirrors the current GSP belt runtime. The runtime paths below
are authoritative today. Editing a repository copy does not change running
behavior until it is deployed with `./deploy.sh --apply`.

## Runtime map

| Repository file | Runtime path | Current runner |
| --- | --- | --- |
| `multica-bridge.cjs` | `/home/newadmin/gsp-multica/multica-bridge.cjs` | PM2 app `gsp-multica-bridge` |
| `parity/multica-relay-advance-daemon.cjs` | `/home/newadmin/gsp-multica/parity/multica-relay-advance-daemon.cjs` | PM2 app `multica-relay-advance`, through its wrapper and launcher |
| `multica-cicd-worker.cjs` | `/home/newadmin/multica-cicd-worker.cjs` | PM2 app `multica-cicd-worker` |
| `belt-config-guard.sh` | `/home/newadmin/tools/belt-config-guard.sh` | `belt-config-guard.timer`, which activates `belt-config-guard.service` |
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
operator has approved changing the live runtime. Before every copy, it backs up
the current runtime file as `<runtime-path>.bak-<UTC timestamp>` and restarts
nothing.

`./verify.sh` compares every repository copy with its runtime path and exits
non-zero when any file is missing or differs.
