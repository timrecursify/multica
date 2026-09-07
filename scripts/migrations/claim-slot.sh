#!/usr/bin/env bash
set -euo pipefail
ticket=${1:?usage: $0 TICKET}; root=${MIGRATION_ROOT:-$(git rev-parse --show-toplevel)}
reserved=${RESERVED_FILE:-$root/RESERVED.md}; lock=${RESERVED_LOCK:-$reserved.lock}
mkdir -p "$(dirname "$reserved")"; exec 9>"$lock"
for _ in 1 2 3 4 5; do flock -n 9 && break; sleep .2; done
flock -n 9 || { echo 'reservation lock busy after bounded retries' >&2; exit 75; }
tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
git -C "$root" ls-tree -r --name-only origin/main 2>/dev/null | sed -nE 's#^.*/([0-9]+)_[^/]+\.sql$#\1#p' >"$tmp" || true
[[ -f ${PRODUCTION_MIGRATIONS_FILE:-} ]] && cat "$PRODUCTION_MIGRATIONS_FILE" >>"$tmp" || true
[[ -f ${OPEN_PR_MIGRATIONS_FILE:-} ]] && sed -nE 's#^.*/([0-9]+)_[^/]+\.sql$#\1#p' "$OPEN_PR_MIGRATIONS_FILE" >>"$tmp" || true
if [[ -f $reserved ]] && grep -q "ticket=$ticket " "$reserved"; then grep "ticket=$ticket " "$reserved" | head -1 | sed -nE 's/.*slot=([0-9]+).*/\1/p'; exit 0; fi
slot=1; while grep -qx "$slot" "$tmp" || { [[ -f $reserved ]] && grep -q "slot=$slot " "$reserved"; }; do slot=$((slot+1)); done
printf -v now '%(%Y-%m-%dT%H:%M:%SZ)T' -1; [[ -f $reserved ]] || printf '# Migration slot reservations\n\n' >"$reserved"
printf '%s\n' "- slot=$slot ticket=$ticket provenance=machine:claim-slot.sh timestamp=$now" >>"$reserved"; echo "$slot"
