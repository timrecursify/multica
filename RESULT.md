# Belt Codex gate fix — blocked before live rollout

## Outcome

Diagnosed and locally fixed the belt's Codex executable selection. The focused
wrapper regression test passes. Production was not changed because the required
privileged inspection/deployment path is unavailable non-interactively; per the
brief's hard gate, work stopped at the exact `sudo -n` refusal.

## Root cause

- `/usr/local/bin/codex:2-6,20-26` permits workspace desks and states that belt
  automation must call `/usr/bin/node /opt/gsp-noc/providers/codex/bin/codex.js`
  directly; other working directories are refused with exit 77.
- `ops/belt/multica-daemon-wrapper.sh:33-38` previously defaulted `CODEX_BIN` to
  `/usr/local/bin/codex`.
- `server/internal/daemon/agents_probe.go:131-145,174-175` proves the daemon does
  not consume `CODEX_BIN`; it probes `MULTICA_CODEX_PATH` and resolves the
  executable at startup.
- `server/internal/daemon/daemon.go:6252-6259` passes that resolved path to the
  backend; `server/pkg/agent/codex.go:921-929,979` executes it.
- `/opt/gsp-noc/providers/codex/bin/codex.js:1-4` is executable and has the
  `#!/usr/bin/env node` entrypoint, so pinning that file bypasses the shim while
  retaining the required Node invocation.
- Both live systemd units use the same deployed wrapper:
  `gsp-multica-worker.service` and `gsp-multica-worker-ppp.service` each execute
  `/bin/bash /opt/gsp/multica-workers/gsp-multica-worker/multica-daemon-wrapper.sh`.
  At inspection, both reported `ActiveEnterTimestamp=Sun 2026-09-06 23:51:52 UTC`.

## Blast radius and failed-task evidence

Read-only query, excluding PPP-23686:

```sql
SELECT count(*)
FROM agent_task_queue t
JOIN issue i ON i.id=t.issue_id
WHERE t.created_at >= TIMESTAMPTZ '2026-09-06 22:46:00+00'
  AND t.error LIKE '%codex refused:%'
  AND i.number <> 23686;
```

Result: **423 failed tasks**.

One complete stored error row:

```text
issue=24184 task=b5258da1-254e-4b60-a648-6416edb9f312 status=failed
created_at=2026-09-07 04:22:25+00
codex initialize failed: codex process exited; codex stderr: codex refused: desks on gsp run only under /var/lib/****/dev/<work>/ or as Multica belt automation. cwd=/var/lib/gsp/multica/workspaces/da3c5c5c-a123-4567-b999-c3ed1820da00/b5258da1/workdir
```

The password segment above is redacted by the sanctioned database query layer.

## Local change and QC

- `ops/belt/multica-daemon-wrapper.sh`: default to
  `/opt/gsp-noc/providers/codex/bin/codex.js`, honor `MULTICA_CODEX_PATH` first,
  preserve `CODEX_BIN` compatibility and the paid-lane guard, and export the
  effective path through both variables.
- `ops/belt/wrapper.test.sh`: assert the daemon receives the direct `codex.js`
  path and never receives `/usr/local/bin/codex`.
- QC: `bash ops/belt/wrapper.test.sh` exited 0 with
  `wrapper launch regression passed`.
- `sk graph impact ops/belt/multica-daemon-wrapper.sh` remains unavailable:
  graph build did not complete within the bounded run and impact reports no
  graph at SHA `df68ac399b12d7e7d551654c3ddb91638ae5cafc`.

## Live proof and 15-minute QC

Before count query:

```sql
SELECT count(*)
FROM agent_task_queue t
JOIN issue i ON i.id=t.issue_id
WHERE t.created_at >= now()-interval '15 minutes'
  AND t.error LIKE '%codex refused:%'
  AND i.number <> 23686;
```

Result before rollout: **29**.

No after count, restarted-process proof, `pm_exec_path` evidence, or successful
post-fix task is available because production was not changed.

## Blocker / next action for Tim

Exact refused commands:

```text
sudo -n -u gsp-multica env PM2_HOME=/var/lib/gsp-multica/.pm2 /usr/bin/pm2 jlist
sudo: a password is required

sudo -n stat -c '%y %U:%G %a %n' /opt/gsp/multica-workers/gsp-multica-worker/multica-daemon-wrapper.sh /opt/gsp/multica-workers/gsp-multica-worker/server
sudo: a password is required
```

Tim must provide the supervisor-owned privileged rollout path (or apply the
equivalent `MULTICA_CODEX_PATH=/opt/gsp-noc/providers/codex/bin/codex.js` unit
configuration to both worker units), restart both units, and then permit QC to
compare file mtime to process start, run one non-money task, and repeat the
15-minute count. Do not edit `/usr/local/bin/codex` or `/etc/sk/perm`.

The caller inbox is also unavailable outside this lane:
`/home/newadmin/.local/bin/sk spawn inbox` exits 8 because `cc-intercom` is
missing.

## Round 2

- Branch: `fix/belt-codex-path-20260907` (based on `origin/main`; `origin/master` is absent).
- Commit SHA: `127d9d27eccbac1a64d6e645d98e7554463810c0`.
- PR URL: https://github.com/timrecursify/multica/pull/676
- `bash -n ops/belt/multica-daemon-wrapper.sh`: exit 0.
- `bash ops/belt/wrapper.test.sh`: exit 0 (`wrapper launch regression passed`).
