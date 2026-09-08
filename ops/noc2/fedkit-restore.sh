#!/usr/bin/env bash
set -Eeuo pipefail
MANIFEST=${MANIFEST:-$(dirname "$0")/fedkit-allowlist.conf}; CHECKPOINT=${CHECKPOINT:-/var/lib/fedkit/old-host-fenced}; DRY_RUN=${DRY_RUN:-0}; STAGING=${STAGING:-/var/lib/fedkit/restore-staging}
[[ -r "$MANIFEST" ]] || { echo 'allow-list missing' >&2; exit 2; }
[[ -s "$CHECKPOINT" ]] || { echo 'old-host-fenced checkpoint required' >&2; exit 3; }
grep -q '^fedkit-fence-v1 ' "$CHECKPOINT" || { echo 'malformed fence checkpoint' >&2; exit 3; }
command -v restic >/dev/null || { echo 'restic is required' >&2; exit 4; }
(( DRY_RUN )) && { echo 'restore dry-run: manifest validated; no writes performed'; exit 0; }
rm -rf -- "$STAGING"; mkdir -p "$STAGING"
restic restore latest --target "$STAGING" --include-file "$MANIFEST" --verify
while IFS='=' read -r key path; do [[ -z "$key" || "$key" == \#* ]] && continue; [[ "$path" != /* || "$path" == *..* ]] && { echo 'unsafe allow-list path' >&2; exit 6; }; done < "$MANIFEST"
echo "staged restore at $STAGING; review plan before replay"
