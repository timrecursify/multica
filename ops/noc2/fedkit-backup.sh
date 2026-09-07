#!/usr/bin/env bash
set -Eeuo pipefail
# Huawei recovery-stick snapshot job. All inputs are explicit and credentials
# are supplied by the environment (never tracked in this repository).
STICK_MOUNT=${STICK_MOUNT:-/run/media/root/FEDKIT}
REPO=${REPO:-$STICK_MOUNT/restic}
PI_REPO=${PI_REPO:-sftp:pi-mesh:/mnt/ssd/backups/fedkit-huawei}
MANIFEST=${MANIFEST:-$(dirname "$0")/fedkit-allowlist.conf}
STAGING=${STAGING:-$STICK_MOUNT/fedkit-staging}
PASSWORD_FILE=${PASSWORD_FILE:-${RESTIC_PASSWORD_FILE:-}}
MIRROR_RETRIES=${MIRROR_RETRIES:-3}
DRY_RUN=${DRY_RUN:-0}
log(){ printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
[[ -r "$MANIFEST" ]] || { log "missing allow-list: $MANIFEST" >&2; exit 2; }
[[ -d "$STICK_MOUNT" ]] || { log "stick is not mounted: $STICK_MOUNT" >&2; exit 3; }
files_from=$(mktemp)
trap 'rm -f "$files_from"' EXIT
awk -F= 'NF==2 && $1 !~ /^#/ {print $2}' "$MANIFEST" >"$files_from"
printf '%s\n' "$STAGING/pg_dumpall.sql" "$STAGING/redis.rdb" >>"$files_from"
args=(-r "$REPO" backup --files-from "$files_from" --tag huawei-fedkit-$(hostname -s))
if (( DRY_RUN )); then printf 'restic'; printf ' %q' "${args[@]}"; echo; exit 0; fi
mkdir -p "$STAGING"
if command -v pg_dumpall >/dev/null; then pg_dumpall >"$STAGING/pg_dumpall.sql"; else : >"$STAGING/pg_dumpall.sql"; fi
if command -v redis-cli >/dev/null; then redis-cli --rdb "$STAGING/redis.rdb"; else : >"$STAGING/redis.rdb"; fi
if ! restic -r "$REPO" snapshots >/dev/null 2>&1; then
  restic -r "$REPO" init
fi
restic "${args[@]}"
restic -r "$REPO" snapshots >/dev/null
for ((attempt=1; attempt<=MIRROR_RETRIES; attempt++)); do
  RESTIC_REPOSITORY="$PI_REPO" restic copy --from-repository "$REPO" && exit 0
  sleep "$attempt"
done
log 'Pi mirror failed after retries' >&2; exit 7
