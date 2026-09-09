#!/usr/bin/env bash
set -Eeuo pipefail
MANIFEST=${MANIFEST:-$(dirname "$0")/fedkit-allowlist.conf}; CHECKPOINT=${CHECKPOINT:-/var/lib/fedkit/old-host-fenced}; STAGING=${STAGING:-/var/lib/fedkit/staging}; DRY_RUN=${DRY_RUN:-0}
[[ -r "$MANIFEST" ]] || { echo 'allow-list missing' >&2; exit 2; }
[[ -s "$CHECKPOINT" ]] || { echo 'old-host-fenced checkpoint required' >&2; exit 3; }
grep -q '^host_id=' "$CHECKPOINT" || { echo 'malformed fence checkpoint' >&2; exit 3; }
command -v restic >/dev/null || { echo 'restic is required' >&2; exit 4; }
mkdir -p "$STAGING"
restic restore latest --target "$STAGING" --include-file "$MANIFEST" --verify
(( DRY_RUN )) && { echo 'restore dry-run: staged plan validated; no live writes performed'; exit 0; }
echo 'staged restore verified; explicit replay required by provisioning workflow'
