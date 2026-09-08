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
[[ -n "$PASSWORD_FILE" && -r "$PASSWORD_FILE" ]] || { log 'protected RESTIC password file required' >&2; exit 4; }
perm=$(stat -c %a "$PASSWORD_FILE" 2>/dev/null || echo 999); (( 10#$perm <= 640 )) || { log 'password file permissions are too broad' >&2; exit 4; }
mkdir -p "$STAGING"
command -v pg_dumpall >/dev/null || { log 'pg_dumpall required' >&2; exit 5; }; pg_dumpall >"$STAGING/pg_dumpall.sql" || exit 5
command -v redis-cli >/dev/null || { log 'redis-cli required' >&2; exit 5; }; redis-cli --rdb "$STAGING/redis.rdb" || exit 5
[[ -s "$STAGING/pg_dumpall.sql" && -s "$STAGING/redis.rdb" ]] || { log 'required capture empty' >&2; exit 5; }
if ! restic -r "$REPO" snapshots >/dev/null 2>&1; then
  restic -r "$REPO" init
fi
RESTIC_PASSWORD_FILE="$PASSWORD_FILE" restic "${args[@]}"
snapshot_id=$(RESTIC_PASSWORD_FILE="$PASSWORD_FILE" restic -r "$REPO" snapshots --json | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | tail -1)
[[ -n "$snapshot_id" ]] || { log 'snapshot id unavailable' >&2; exit 6; }
for ((attempt=1; attempt<=MIRROR_RETRIES; attempt++)); do
  RESTIC_PASSWORD_FILE="$PASSWORD_FILE" RESTIC_REPOSITORY="$PI_REPO" restic copy --from-repository "$REPO" && RESTIC_PASSWORD_FILE="$PASSWORD_FILE" RESTIC_REPOSITORY="$PI_REPO" restic dump "$snapshot_id" fedkit-allowlist.conf >/dev/null 2>&1 && exit 0
  sleep "$attempt"
done
log 'Pi mirror failed after retries' >&2; exit 7
