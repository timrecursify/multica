## Raw-SSH fallback evidence

Use this read-only procedure when the brain search does not contain the canonical
footage-archive lifecycle decision. The canonical repository is
`https://github.com/timrecursify/multica`; this investigation is pinned to
commit `d1be2a6db9e329da7587e471dfd5b2403393c39d`.

### Reproducible command sequence

Run from a fresh managed checkout, recording UTC timestamps and complete stdout
and stderr for each command:

```bash
export CHECKOUT="$PWD/multica"
git -C "$CHECKOUT" rev-parse HEAD
git -C "$CHECKOUT" status --short
git -C "$CHECKOUT" show --no-ext-diff --stat --oneline d1be2a6db9e329da7587e471dfd5b2403393c39d
sed -n '91,103p' "$CHECKOUT/ops/gsp-belt/README.md"
sed -n '1,20p' "$CHECKOUT/ops/belt/deploy-decision.cjs"
sed -n '1,55p' "$CHECKOUT/ops/belt/deploy.sh"
date -u +%Y-%m-%dT%H:%M:%SZ
```

The cited sources establish that `ops/belt/deploy.sh` is the supported
receipt-producing entrypoint, accepts a 40-character `--source-commit`, and
materializes freshly fetched `origin/main`. `deploy-decision.cjs` returns
`noop` when live equals main, `refuse` when live differs from both main and the
last deployment, and `deploy` otherwise. `deploy.sh` verifies the requested SHA
against the checkout and refuses an unscoped `--apply`.

### Safety and stop conditions

Do not run `--apply`, `--rollback`, or any command that writes to the runtime;
this fallback is evidence collection only. Stop and report the exact command
and output if the checkout is not at the pinned SHA, has uncommitted changes,
the cited files are absent or differ, SSH credentials/host access are missing,
or any command requests mutation. Do not search outside the checkout (no
filesystem-wide `find`/`rg`); unresolved runtime host or retention details are
an explicit evidence gap, not grounds for inference.
