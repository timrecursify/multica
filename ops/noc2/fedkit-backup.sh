#!/usr/bin/env bash
set -Eeuo pipefail
# Huawei recovery-stick snapshot job. All inputs are explicit and credentials
# are supplied by the environment (never tracked in this repository).
STICK_MOUNT=${STICK_MOUNT:-/run/media/root/FEDKIT}
REPO=${REPO:-$STICK_MOUNT/restic}
PI_REPO=${PI_REPO:-sftp:pi-mesh:/mnt/ssd/backups/fedkit-huawei}
MANIFEST=${MANIFEST:-$(dirname "$0")/fedkit-allowlist.conf}
DRY_RUN=${DRY_RUN:-0}
log(){ printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
[[ -r "$MANIFEST" ]] || { log "missing allow-list: $MANIFEST" >&2; exit 2; }
[[ -d "$STICK_MOUNT" ]] || { log "stick is not mounted: $STICK_MOUNT" >&2; exit 3; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
stage_manifest="$tmp/manifest"
awk -F= 'NF==2 && $1 !~ /^#/ {print $2}' "$MANIFEST" >"$stage_manifest"
if (( ! DRY_RUN )); then
  mkdir -p "$tmp/var/lib/fedkit-captures"
  pg_dumpall >"$tmp/var/lib/fedkit-captures/pg_dumpall.sql" 2>/dev/null || :
  redis-cli --rdb "$tmp/var/lib/fedkit-captures/redis.rdb" 2>/dev/null || :
fi
printf '%s\n' "$tmp/var/lib/fedkit-captures/pg_dumpall.sql" "$tmp/var/lib/fedkit-captures/redis.rdb" >>"$stage_manifest"
args=(-r "$REPO" backup --files-from "$stage_manifest" --tag huawei-fedkit-$(hostname -s))
if (( DRY_RUN )); then printf 'restic'; printf ' %q' "${args[@]}"; echo; exit 0; fi
[[ -n ${RESTIC_PASSWORD:-} ]] || { log 'RESTIC_PASSWORD is required'; exit 4; }
if ! restic -r "$REPO" snapshots >/dev/null 2>&1; then restic -r "$REPO" init; fi
restic "${args[@]}"
restic -r "$REPO" snapshots >/dev/null
for attempt in 1 2 3; do RESTIC_REPOSITORY="$PI_REPO" restic copy --from-repository "$REPO" && break; (( attempt == 3 )) && exit 5; sleep "$attempt"; done
