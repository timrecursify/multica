# Belt runtime mirror

This directory mirrors the current GSP belt runtime. The runtime paths below
are authoritative today. Editing a repository copy does not change running
behavior until it is deployed with `./deploy.sh --apply`.

## Release permissions

`deploy-release.sh` runs `normalize-release-permissions.sh` after building a
release. It grants read/execute access to release directories and read access
to non-credential files, removes all write bits, and preserves the existing
read scope of credential material (`.env*`, `*secret*`, `*credential*`, and
private-key formats). For the already-deployed NOC2 intercom tree, an operator
with root access can remediate the permission regression with:

```sh
sudo find /var/lib/codex-consiglieri/intercom-v2/dist -type d -exec chmod a+rx,a-w -- {} +
sudo find /var/lib/codex-consiglieri/intercom-v2/dist -type f -exec chmod a+r,a-w -- {} +
```

Run the one-time remediation only after confirming that the tree contains no
credential files requiring owner-only reads; apply the deployment helper for
future releases.

Explicit terminal exits require `RELAY_OPERATOR_SECRET` in the bridge
environment and the matching `X-Relay-Operator-Secret` request header. If the
environment variable is unset, those exceptional exits are refused.

## Runtime map

| Repository file | Runtime path | Current runner |
| --- | --- | --- |
| `multica-bridge.cjs` | `/var/lib/gsp/gsp-multica/multica-bridge.cjs` | PM2 app `gsp-multica-bridge` |
| `guardrails.cjs` | `/var/lib/gsp/gsp-multica/guardrails.cjs` | Required by bridge and relay daemon |
| `parity/multica-relay-advance-daemon.cjs` | `/var/lib/gsp/gsp-multica/parity/multica-relay-advance-daemon.cjs` | PM2 app `multica-relay-advance`, through its wrapper and launcher |
| `multica-cicd-worker.cjs` | `/var/lib/gsp/multica-cicd-worker.cjs` | PM2 app `multica-cicd-worker` |
| `belt-config-guard.sh` | `/var/lib/gsp/tools/belt-config-guard.sh` | `belt-config-guard.timer`, which activates `belt-config-guard.service` |

To intentionally hold the AI worker during spend investigations or guarded
deploys, create `/var/lib/gsp/.local/state/multica-ai-hold`. The guard then
skips only `gsp-multica-worker`; bridge, CI/CD, archiver, and relay liveness
checks continue. Remove the marker only after the worker may safely resume.
| `multica-bundle.py` | `/var/lib/gsp/tools/multica-bundle.py` | No always-running PM2 app or systemd unit; the runbook invokes it with `python3` |
| `RUNBOOK_SPEC_WORKER.md` | `/var/lib/gsp/multica-doctrine/RUNBOOK_SPEC_WORKER.md` | No process; this is the operational runbook |

## Guard parity repair

`belt-config-guard.sh` treats the guard and daemon wrapper as one deployment
unit. Their canonical source paths are `ops/belt/belt-config-guard.sh` and
`ops/belt/multica-daemon-wrapper.sh`; the runtime copies are
`/var/lib/gsp/tools/belt-config-guard.sh` and
`/var/lib/gsp/gsp-multica/fleet/multica-daemon-wrapper.sh`. A repair may use
only an immutable release containing both matching blobs and a readable
`.gsp-belt-release.json` with a 40-character `source_sha` and 64-character
`manifest_sha256`. Validation completes before either runtime file is touched.

Operator-visible repair diagnostics are classified as `missing` (source or
runtime input), `incomplete-release` (release root, blobs, or checksum/ref),
or `class=permission` (lock, staging, directory, or atomic rename failure).
Any such diagnostic leaves parity failed, so relay recovery and status writes
are refused until a subsequent guard run can prove matching digests.

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
as `python3 /var/lib/gsp/tools/multica-bundle.py`.

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
