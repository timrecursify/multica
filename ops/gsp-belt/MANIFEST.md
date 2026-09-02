# GSP belt runtime manifest

Every tracked runtime file, its deployed process/path, and the PM2 app that
consumes it. The manifest is the single source of truth that `gsp-belt-deploy.sh`
and `belt-guard-check.sh` validate against. Any tracked file not listed here is
a drift flag; any deployed path not resolvable back to a manifest entry is a
guard failure.

## Release layout

An immutable release lives at `<release>/ops/gsp-belt` (same tree as this file).
Paths below are relative to that root and must stay inside it at deploy time.

| Manifest path | Shipped to (runtime) | Consumed by (PM2 app) | Notes |
| --- | --- | --- | --- |
| `ops/gsp-belt/bridge/multica-bridge.cjs` | `<release>/ops/gsp-belt/bridge/multica-bridge.cjs` | `gsp-multica-bridge`, `multica-relay-advance` (dispatcher calls `:5005`) | Relay bridge; SHA-256 migration provenance below |
| `ops/gsp-belt/worker/multica-cicd-worker.cjs` | `<release>/ops/gsp-belt/worker/multica-cicd-worker.cjs` | `multica-cicd-worker` | CI/CD & Deploy consumer |
| `ops/gsp-belt/worker/multica-archiver.cjs` | `<release>/ops/gsp-belt/worker/multica-archiver.cjs` | `multica-archiver` | Done->Archived |
| `ops/gsp-belt/fleet/multica-daemon-wrapper.sh` | `<release>/ops/gsp-belt/fleet/multica-daemon-wrapper.sh` | `gsp-multica-worker` | Build lane daemon entry |
| `ops/gsp-belt/fleet/multica-fleet-daemon.sh` | `<release>/ops/gsp-belt/fleet/multica-fleet-daemon.sh` | `gsp-multica-fleet` | Fleet daemon entry |
| `ops/gsp-belt/fleet/multica-relay-local.sh` | `<release>/ops/gsp-belt/fleet/multica-relay-local.sh` | (manual / local relay) | Bridge on `:5006` |
| `ops/gsp-belt/fleet/ecosystem.gsp-belt.config.js.in` | rendered → `<release>/ops/gsp-belt/fleet/ecosystem.gsp-belt.config.js` | all apps above | Tracked template; deploy renders with release path |
| `ops/gsp-belt/relay/multica-relay-advance-daemon.cjs` | `<release>/ops/gsp-belt/relay/multica-relay-advance-daemon.cjs` | `multica-relay-advance` | Requeue + advance pass |
| `ops/gsp-belt/relay/multica-relay-advance-launcher.cjs` | `<release>/ops/gsp-belt/relay/multica-relay-advance-launcher.cjs` | `multica-relay-advance` | Renders env from operator `.env` |
| `ops/gsp-belt/relay/multica-relay-advance-wrapper.sh` | `<release>/ops/gsp-belt/relay/multica-relay-advance-wrapper.sh` | `multica-relay-advance` | PM2 entry |
| Not run by PM2 — migration/parity SQL kept for provenance | `<release>/ops/gsp-belt/sql/*.sql` | (`noc2`/`prod` parity; seed) | Read-only, applied separately |

## Migration provenance

The bridge imported below was captured from the running home-directory tree on
2026-08-31. **The running baseline moved after the spec was written**: the spec
cites SHA-256 `c5468dcc298eef11e2fe90754559ecf599ca43e10d5e36bdf6317f92462fb947`
(a check at 2026-08-31 03:11), but a `childguard` edit landed at 03:37 and the
bridge has been restarted since. The bridge byte-imported into Git is the
current running baseline, not the spec's stale citation.

| File | SHA-256 (current running baseline, 2026-08-31 ~14:57Z) |
| --- | --- |
| `ops/gsp-belt/bridge/multica-bridge.cjs` | `9387e6a885aa0c1a70791ed3f5f9e43280ae90c5c1a1e32a61925d57369f38a5` |
| `ops/gsp-belt/relay/multica-relay-advance-daemon.cjs` | `7edb2154ddfde9705e7d632f8b02511ae182a2d84b412eb62b3b2d9f0e2fcfad` |
| `ops/gsp-belt/worker/multica-cicd-worker.cjs` | `bdbf94cab9e1bbff03144755b2c615506f5f4601f6272ae28e0e81c7f1877ec7` |
| `ops/gsp-belt/worker/multica-archiver.cjs` | `37489eda36e7bc828138e9f279eaf87b5bdb055c3cf43b2eb9988e97c3884893` |

Run `bash ops/gsp-belt/scripts/belt-fingerprint.sh` (or `belt-guard-check.sh`) on a
deployed release to reconfirm the checksums of every manifest file against the
source commit; a mismatch is reported as drift.

## Env contract

Secrets are never committed. `GSP_BELT_ENV_FILE` (handled by the deploy tool),
`GSP_BELT_SECRETS_DIR` (worker wrapper), `GSP_BELT_SECRETS_ENV_FILE` and
`GSP_BELT_PG_MODULE` (cicd worker) hold the real values at runtime. Templates
live in `fleet/ecosystem.gsp-belt.config.js.in` and `.env.example`.
