# Deployment receipt contract

This is the single contract between a deployment owner and
`multica-cicd-worker.cjs`. A merge, workflow name, workflow result, release
directory, or process age is not activation evidence.

## Identity and lookup

The receipt key is the tuple `(repository, target, source_sha)`:

```text
${MULTICA_RECEIPT_ROOT}/${repository}/${target}/${source_sha}.json
```

- `repository` is the exact GitHub `owner/name` (for example,
  `timrecursify/multica`). The slash intentionally creates two path segments.
- `target` is the stable deployment target selected by the changed-path
  manifest.
- `source_sha` is the exact 40-character lowercase source commit SHA activated
  by the target.

The consumer performs an exact lookup. It does not scan receipt directories,
select a newer receipt, accept an ancestor, or infer activation from workflow
names. The deployment owner must write the final path only after activation and
health verification both succeed. Writers should create a complete temporary
file in the same directory and rename it atomically to the final path.

## Schema version 1

```json
{
  "schema_version": 1,
  "repository": "timrecursify/multica",
  "target": "gsp-belt",
  "deployment_owner": "ops/belt/deploy.sh",
  "source_sha": "0123456789abcdef0123456789abcdef01234567",
  "activation": {
    "status": "activated",
    "activated_at": "2026-09-07T14:00:00Z",
    "process_sha": "0123456789abcdef0123456789abcdef01234567",
    "release": "/opt/gsp/multica-workers/releases/0123456789abcdef0123456789abcdef01234567"
  },
  "health": {
    "status": "ok",
    "checked_at": "2026-09-07T14:00:05Z",
    "probe": "service-health"
  }
}
```

Required invariants:

- `schema_version` is the number `1`.
- `repository`, `target`, `deployment_owner`, and `source_sha` exactly match the
  requested deployment requirement.
- `activation.status` is `activated`; `activation.activated_at` is a valid
  timestamp; `activation.process_sha` exactly equals `source_sha`;
  `activation.release` is a non-empty immutable release identifier.
- `health.status` is `ok`; `health.checked_at` is a valid timestamp recorded
  after the owner checked the activated target; `health.probe` identifies the
  non-empty probe the deployment owner ran.
- Receipts contain evidence only. They must not contain credentials or secret
  values.

## Target selection

Changed PR paths are the applicability manifest. The worker currently declares:

| Repository | Changed path | Target | Deployment owner |
| --- | --- | --- | --- |
| `timrecursify/multica` | `ops/belt/**`, `ops/gsp-belt/**` | `gsp-belt` | `ops/belt/deploy.sh` |
| `timrecursify/multica` | any other non-docs path | `gsp-multica` | `multica-application-deployer` |
| `timrecursify/sk-cli` | any non-docs path | `fleet-sk-cli` | `sk-cli-release` |
| `timrecursify/ppp` | any non-docs path | `ppp-production` | `ppp-release` |

A PR can select multiple rows. Every selected target must provide its own valid
receipt for the same source SHA. Only changes whose complete manifest consists
of Markdown files or paths below `docs/` are `verified_not_applicable`.

## Consumer outcomes

- `deployed`: every selected target has a valid exact receipt. Done is allowed.
- `verified_not_applicable`: the changed-path manifest proves docs-only work.
  Done is allowed.
- `pending`: at least one exact receipt is not present. The issue remains in
  CI/CD & Deploy with a retry-eligible typed blocker.
- `discovery_unavailable`: changed-path or receipt discovery failed or could be
  incomplete. The issue remains in CI/CD & Deploy with a retry-eligible typed
  blocker.
- `failed`: a receipt is present but violates the contract, or the repository
  has no declared target mapping. Done is refused.

Only `deployed` and `verified_not_applicable` can authorize Done.
