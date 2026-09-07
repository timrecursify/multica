#!/usr/bin/env bash
set -Eeuo pipefail
MANIFEST=${MANIFEST:-$(dirname "$0")/fedkit-allowlist.conf}; CHECKPOINT=${CHECKPOINT:-/var/lib/fedkit/old-host-fenced}; DRY_RUN=${DRY_RUN:-0}
[[ -r "$MANIFEST" ]] || { echo 'allow-list missing' >&2; exit 2; }
if [[ ! -e "$CHECKPOINT" ]]; then echo 'old-host-fenced checkpoint required; create it after confirming this is a replacement host' >&2; exit 3; fi
command -v restic >/dev/null || { echo 'restic is required' >&2; exit 4; }
(( DRY_RUN )) && { echo 'restore dry-run: manifest validated; no writes performed'; exit 0; }
restic restore latest --target / --include-file "$MANIFEST" --verify
