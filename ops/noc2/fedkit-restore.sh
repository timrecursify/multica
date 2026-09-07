#!/usr/bin/env bash
set -Eeuo pipefail
MANIFEST=${MANIFEST:-$(dirname "$0")/fedkit-allowlist.conf}; CHECKPOINT=${CHECKPOINT:-/var/lib/fedkit/old-host-fenced}; DRY_RUN=${DRY_RUN:-0}
REPO=${REPO:-/run/media/root/FEDKIT/restic}
[[ -r "$MANIFEST" ]] || { echo 'allow-list missing' >&2; exit 2; }
if [[ ! -e "$CHECKPOINT" ]]; then echo 'old-host-fenced checkpoint required; create it after confirming this is a replacement host' >&2; exit 3; fi
command -v restic >/dev/null || { echo 'restic is required' >&2; exit 4; }
[[ "$REPO" == /run/media/root/FEDKIT/* || "$REPO" == /mnt/fedkit/* ]] || { echo 'repository outside allow-list' >&2; exit 5; }
(( DRY_RUN )) && { echo 'restore dry-run: manifest validated; no writes performed'; exit 0; }
restic -r "$REPO" snapshots >/dev/null 2>&1 || { echo 'missing repository or wrong passphrase' >&2; exit 6; }
restic restore latest --target / --include-file "$MANIFEST" --verify || { echo 'incomplete snapshot or wrong passphrase' >&2; exit 7; }
