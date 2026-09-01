# PPP Multica daemon parity runbook

This is a production handoff only. The service is a user-level systemd unit;
these steps do not run in the build or GSP workspace.

## Contract

- Unit: `multica-daemon-ppp.service`.
- Profile and daemon ID: `ppp-prod-codex`.
- Profile-derived health port: `19909` (`19514 + 1 + byte-sum(profile) % 1000`).
- Workspace root: `/var/lib/multica-ppp/workspaces`.
- Provider policy: `MULTICA_DAEMON_ALLOWED_PROVIDERS=codex`; no paid relay or
  alternate provider is exposed.
- Concurrency: two tasks. The entrypoint holds an `flock` over the workspace
  root, so a duplicate launch exits without claiming work.
- Restart durability: all daemon flags live in the committed entrypoint and
  `Restart=always`/bounded start limits live in the unit. `--no-auto-update`
  and `--no-auto-reload` keep systemd as the supervisor.

## Proposed live installation (do not run as part of this PR)

```bash
cd /home/newadmin/multica-daemon
sudo install -d -o newadmin -g newadmin -m 0750 /var/lib/multica-ppp/workspaces
sudo install -d -m 0755 /etc/multica
sudo install -m 0600 ops/ppp/ppp-daemon.env.example /etc/multica/ppp-daemon.env
# Replace only <PPP_MULTICA_SERVER_URL>; keep credentials in the profile config.
multica login --profile ppp-prod-codex
ops/ppp/install-multica-daemon-ppp.sh
systemctl --user start multica-daemon-ppp.service
systemctl --user status multica-daemon-ppp.service --no-pager
curl --fail --silent http://127.0.0.1:19909/health
```

Before starting, run `ops/ppp/install-multica-daemon-ppp.sh --check` and verify
that `multica daemon probe-runtimes --profile ppp-prod-codex` reports only
`codex`. Do not enable or start any GSP profile from this runbook.

## Rollback

```bash
systemctl --user stop multica-daemon-ppp.service
ops/ppp/install-multica-daemon-ppp.sh --uninstall
```

The stop is the only production mutation in rollback; workspace data and the
profile token remain for supervised recovery. Restore the previous unit and
wrapper from the deployment artifact, then run `systemctl --user daemon-reload`
and `systemctl --user start` only after the operator confirms the replacement.
