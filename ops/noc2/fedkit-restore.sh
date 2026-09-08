#!/usr/bin/env bash
set -Eeuo pipefail
MANIFEST=${MANIFEST:-$(dirname "$0")/fedkit-allowlist.conf}; CHECKPOINT=${CHECKPOINT:-/var/lib/fedkit/old-host-fenced}; DRY_RUN=${DRY_RUN:-0}
[[ -r "$MANIFEST" ]] || { echo 'allow-list missing' >&2; exit 2; }
[[ -f "$CHECKPOINT" ]] || { echo 'old-host-fenced checkpoint required' >&2; exit 3; }
(( DRY_RUN )) || grep -q 'host=' "$CHECKPOINT" || { echo 'malformed fence checkpoint' >&2; exit 3; }
command -v restic >/dev/null || { echo 'restic is required' >&2; exit 4; }
STAGE=${STAGE:-$(mktemp -d /tmp/fedkit-restore.XXXXXX)}
trap 'rm -rf "$STAGE"' EXIT
(( DRY_RUN )) && { echo 'restore dry-run: manifest validated; no writes performed'; exit 0; }
restic restore latest --target "$STAGE" --include-file "$MANIFEST" --verify
echo "staged restore ready at $STAGE; review plan before replay"
