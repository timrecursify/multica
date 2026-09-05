# GSP belt runtime

The complete GSP belt process runtime, versioned under Git so every change is a
reviewable diff and a rollback is a checkout/release selection — not an
archaeology exercise over sibling `.bak` files. This addresses GSP-734.

## What's here

```
ops/gsp-belt/
  MANIFEST.md                     # file -> process -> PM2 app mapping + migration SHA
  .env.example                    # operator env template (inert placeholders)
  bridge/multica-bridge.cjs       # relay/SAML bridge (pm2 gsp-multica-bridge)
  relay/                          # relay-advance daemon + launch wrapper/dir (pm2 multica-relay-advance)
  worker/                         # cicd + archiver workers (pm2 multica-cicd-worker / multica-archiver)
  fleet/                          # wrapper scripts + ecosystem template (pm2 gsp-multica-worker, fleet daemon)
  sql/                            # noc2/prod parity DDL + seed (read-only provenance)
  scripts/belt-fingerprint.sh     # drift detection
  scripts/belt-guard-check.sh     # deploy guard (CI + local)
  deploy/gsp-belt-deploy.sh       # immutable-release cutover with preflight + rollback
  test/                           # fake pm2 + behavioral tests
```

Secrets are never committed. Runtime files that need real credentials read them
from operator-controlled env files, referenced only by environment-variable
name with documented defaults pointing at the current install.

## Initial import

The files here were copied byte-for-byte from the running home-directory tree on
2026-08-31 (bridge SHA `9387e6a8…`, daemon `7edb2154…`, cicd-worker
`9220a91c…`, archiver `37489eda…`). Three small edits intentionally made the
tracked copies environment/template-driven rather than hard-coded to one host:

1. `fleet/ecosystem.gsp-belt.config.js.in` — the template pins only the
   `__GSP_BELT_RELEASE__` script base at render time via `gsp-belt-deploy.sh`;
   it no longer hard-codes `/home/newadmin/gsp-multica` script paths.
2. `relay/multica-relay-advance-launcher.cjs` / `-wrapper.sh` — now self-relative
   and read operator env from `GSP_BELT_ENV_FILE` (falling back to
   `ops/gsp-belt/.env.example` only to validate key presence), so a release
   checkout works from any directory.
3. `fleet/*-daemon-wrapper.sh`, `fleet/multica-fleet-daemon.sh`, and
   `worker/multica-cicd-worker.cjs` externalize secret file paths and the `pg`
   module path via `GSP_BELT_SECRETS_DIR`, `GSP_BELT_SECRETS_ENV_FILE`, and
   `GSP_BELT_PG_MODULE` (documented defaults preserve current behavior).

Everything else is a byte-identical copy of the running baseline. The manifest's
migration-provenance table lets you verify the import is the running bridge.

## Host dependencies (documented, not committed)

| Environment variable | Default (current install) | Used by |
| --- | --- | --- |
| `GSP_BELT_ENV_FILE` | (unset → example) | relay launcher reads `DATABASE_URL`, `RELAY_AGENT_SECRET`, `GSP_WORKSPACE_ID` |
| `GSP_BELT_SECRETS_DIR` | `/home/newadmin/.secrets` | daemon/fleet wrappers source `deepseek.env`, `openrouter.env` |
| `GSP_BELT_SECRETS_ENV_FILE` | `/home/newadmin/.secrets/multica-remote/remote-bridge.env` | cicd worker |
| `GSP_BELT_PG_MODULE` | `/home/newadmin/node_modules/pg` | cicd worker `pg` module path |
| `CICD_RATE_LIMIT_BASE_MS` | `30000` | cicd worker initial rate-limit backoff |
| `CICD_RATE_LIMIT_MAX_MS` | `900000` | cicd worker maximum rate-limit cooldown |
| `GITHUB_APP_ID` | (required unless token is supplied) | GitHub App id used to mint the belt installation token |
| `GITHUB_APP_INSTALLATION_ID` | (required unless token is supplied) | GitHub App installation id |
| `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_PRIVATE_KEY_FILE` | (secret) | App signing key, supplied only by the runtime secret manager |
| `GITHUB_APP_INSTALLATION_TOKEN` | (optional) | Pre-minted installation token for runtimes that mint outside the worker |
| `GITHUB_RATE_LIMIT_STATE_FILE` | `/tmp/multica-github-rate-limit.json` | Shared cross-process cooldown state |
| `CICD_ATTEMPT_TIMEOUT_MS` | `2700000` | watchdog threshold for stale CI/CD attempts (45 minutes) |
| `GSP_BELT_CODEX_BIN` | `/home/newadmin/tools/codex-native` | daemon wrapper codex binary |
| `MULTICA_DAEMON_DIR` | `/home/newadmin/multica-daemon` | daemon/fleet server binary + workdir |
| `GSP_WORKSPACES_ROOT` | `/home/newadmin/multica-workspaces-gsp` | daemon `--workspaces-root` |

## Review

```bash
bash ops/gsp-belt/scripts/belt-guard-check.sh --checkout <reviewed-checkout>
```

This fails CI whenever a manifest source is untracked/missing, a deployed source
differs from the selected ref (add `--release`), the ecosystem references an
unmanaged home-directory script, a secret-shaped value is embedded in tracked
config, or a required env name is missing.

## Deployment (cutover)

The legacy `ops/gsp-belt/deploy/gsp-belt-deploy.sh` is disabled. Use the
receipt-producing belt deploy entrypoint:

```bash
bash ops/belt/deploy.sh --dry-run --source-commit <40-character-commit>
# Apply copies only from freshly fetched origin/main and writes a receipt.
bash ops/belt/deploy.sh --apply --source-commit <40-character-commit>
```

The deploy script does not accept an arbitrary ref: `--source-commit` is an
auditable request identifier and the materialized source is `origin/main`.

## Rollback

Rollback uses the receipt timestamp:

```bash
bash ops/belt/deploy.sh --rollback <YYYYMMDDTHHMMSSZ>
```

The deploy tool restores its timestamped backup files on failure.

## Drift detection

```bash
bash ops/gsp-belt/scripts/belt-fingerprint.sh --checkout <reviewed-checkout> --release <release-dir>
# guard-check --release is the one-shot CI form; exits non-zero on drift.
bash ops/gsp-belt/scripts/belt-guard-check.sh --checkout <reviewed-checkout> --release <release-dir>
```

## Runtime provenance

After a cutover, report the exact commit and the resolved PM2 script path for
each of the five belt apps without exposing environment values:

```bash
bash <release-dir>/ops/gsp-belt/scripts/belt-status.sh --release <release-dir>
```

It exits non-zero if an app is offline or resolves outside that immutable
release.

To compare restart counters after a cutover (the bridge form remains supported):

```bash
bash <release-dir>/ops/gsp-belt/scripts/belt-status.sh --release <release-dir> \
  --baseline-relay-unstable-restarts <count>
```

If the relay counter increases, inspect the emitted PM2 error-log path and exit
code/signal, correct the operator environment or deployment, then rerun status.

The worker restart-burst finding tracks the PM2 `unstable_restarts` counter
between status runs. By default it reports unhealthy when more than 3 restarts
are observed within 300 seconds. Configure with
`--worker-restart-burst-threshold`, `--worker-restart-burst-window-seconds`,
and `--worker-restart-burst-state` (or the corresponding
`GSP_WORKER_RESTART_BURST_*` environment variables). A missing or malformed
worker counter is a diagnostic failure; inspect the emitted `pm2_error_log`
path and remediate the worker before rerunning the check.

## Dispatch controls

`RECONCILE_MAX_CREATE_PER_CYCLE` limits tasks created per cycle; set it to `0` to halt task creation. `RECONCILE_DISPATCH_HOLD=1` is the supported way to stop dispatch, holding the reconcile cycle before any database access.

## Fleet health watchdog

`/health` includes `last_tick_completed_at`, `tick_count`, and
`last_tick_outcome` alongside the existing heartbeat fields. `scripts/fleet-health.sh`
uses independent defaults of 90 seconds for `MULTICA_HEARTBEAT_MAX_AGE_SECONDS`
and 120 seconds for `MULTICA_TICK_MAX_AGE_SECONDS`. `--repair` restarts PM2 only
when a selected predicate fails and verifies recovery. Exit 0 is healthy, exit 1
identifies unavailable/stale/wedged conditions, and exit 2 means invalid arguments.
Missing or malformed telemetry is unhealthy.

## Tests

```bash
bash ops/gsp-belt/test/deploy-tool.test.sh   # dry-run, preflight, missing-input, rollback
bash ops/gsp-belt/test/guard-check.test.sh   # secret + unmanaged-script guards
bash ops/gsp-belt/test/relay-advance.integration.test.cjs  # unchanged relay coverage
bash ops/gsp-belt/test/relay-launcher-status.test.cjs      # launcher + restart baseline coverage
```

From a clean checkout the acceptance criterion is that these pass without any
PM2 mutation and without a live database.
