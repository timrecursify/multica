#!/usr/bin/env bash
set -Eeuo pipefail
# Huawei recovery-stick snapshot job. All inputs are explicit and credentials
# are supplied by the environment (never tracked in this repository).
STICK_MOUNT=${STICK_MOUNT:-/run/media/root/FEDKIT}
REPO=${REPO:-$STICK_MOUNT/restic}
PI_REPO=${PI_REPO:-sftp:pi-mesh:/mnt/ssd/backups/fedkit-huawei}
MANIFEST=${MANIFEST:-$(dirname "$0")/fedkit-allowlist.conf}
DRY_RUN=${DRY_RUN:-0}
PASSWORD_FILE=${PASSWORD_FILE:-}; PG_DUMPALL=${PG_DUMPALL:-pg_dumpall}; REDIS_CLI=${REDIS_CLI:-redis-cli}
log(){ printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
[[ -r "$MANIFEST" ]] || { log "missing allow-list: $MANIFEST" >&2; exit 2; }
[[ -d "$STICK_MOUNT" ]] || { log "stick is not mounted: $STICK_MOUNT" >&2; exit 3; }
args=(-r "$REPO" backup --files-from "$MANIFEST" --tag huawei-fedkit-$(hostname -s))
if (( DRY_RUN )); then printf 'restic'; printf ' %q' "${args[@]}"; echo; exit 0; fi
[[ -n "$PASSWORD_FILE" && -r "$PASSWORD_FILE" ]] || { log 'RESTIC_PASSWORD_FILE required'; exit 4; }
export RESTIC_PASSWORD_FILE="$PASSWORD_FILE"
if ! restic -r "$REPO" snapshots >/dev/null 2>&1; then restic -r "$REPO" init; fi
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
"$PG_DUMPALL" >"$tmp/pg_dumpall.sql" 2>/dev/null || log 'pg_dumpall unavailable; continuing'
"$REDIS_CLI" --rdb "$tmp/redis.rdb" >/dev/null 2>&1 || log 'redis capture unavailable; continuing'
cp "$tmp/pg_dumpall.sql" "$STICK_MOUNT/pg_dumpall.sql" 2>/dev/null || true
cp "$tmp/redis.rdb" "$STICK_MOUNT/redis.rdb" 2>/dev/null || true
restic "${args[@]}"
RESTIC_REPOSITORY="$PI_REPO" restic -r "$PI_REPO" init 2>/dev/null || true
restic copy --from-repository "$REPO" --repo "$PI_REPO"
