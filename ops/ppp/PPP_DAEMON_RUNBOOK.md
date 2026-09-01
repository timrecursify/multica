# PPP Multica daemon parity runbook

This is a production handoff for the user-level `ppp-prod-codex` unit. No
command below starts the daemon until the final, explicit `systemctl start`.

## Build and deliver one immutable release

Run on the merged checkout at the exact PR head, then copy the resulting
artifact to `ppp-prod` (the release directory name is the commit SHA):

```bash
SHA="$(git rev-parse HEAD)"
make build
sudo install -d -m 0755 "/opt/multica/releases/$SHA/ops/ppp/systemd"
sudo install -m 0755 server/bin/multica "/opt/multica/releases/$SHA/multica"
sudo install -m 0755 ops/ppp/multica-daemon-ppp.sh "/opt/multica/releases/$SHA/ops/ppp/multica-daemon-ppp.sh"
sudo install -m 0644 ops/ppp/systemd/multica-daemon-ppp.service "/opt/multica/releases/$SHA/ops/ppp/systemd/multica-daemon-ppp.service"
```

The four `install` commands are the deployment boundary: transfer those exact
files (or the equivalent CI artifact) to the same paths on `ppp-prod`; never
use a `current`/`latest` symlink or a source checkout as the daemon binary.

## Install and preflight on `ppp-prod`

```bash
export MULTICA_RELEASE_DIR="/opt/multica/releases/$SHA"
export MULTICA_DAEMON_BIN="$MULTICA_RELEASE_DIR/multica"
export MULTICA_SERVER_URL="https://multica.ai"
multica login --profile ppp-prod-codex
ops/ppp/install-multica-daemon-ppp.sh
ops/ppp/install-multica-daemon-ppp.sh --check
```

The installer discovers and verifies `codex` (or uses an executable
`MULTICA_CODEX_PATH`), verifies the profile token without printing it, checks
the isolated workspace root and the derived health port `19909`, writes a
0600 environment file, and backs up replaced unit/wrapper/env files. It never
copies `ppp-daemon.env.example` and never starts the service.

After the operator reviews the check output:

```bash
systemctl --user start multica-daemon-ppp.service
systemctl --user --no-pager status multica-daemon-ppp.service
curl --fail --silent http://127.0.0.1:19909/health
```

## Rollback and uninstall

An ordinary uninstall refuses while the unit is active. To stop it, the
operator must make that action explicit; the installer then disables the unit,
restores the last backed-up files (or removes newly-created files), and reloads
systemd:

```bash
ops/ppp/install-multica-daemon-ppp.sh --uninstall --confirm-stop
```

Backups remain under
`~/.local/state/multica/ppp-daemon-backups/`. Workspace data and the profile
token are retained. Do not delete either until recovery is confirmed.
