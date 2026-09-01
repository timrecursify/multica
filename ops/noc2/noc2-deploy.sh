#!/usr/bin/env bash
# Fixed-target primitive; the audited sk command fetches and stages artifacts.
set -Eeuo pipefail
BACKEND=multica-backend DAEMON=/home/newadmin/multica-daemon/server RECEIPTS=/var/lib/multica/noc2-receipts
usage(){ echo "usage: $0 --manifest FILE --sha SHA --idempotency-key KEY [--verify]" >&2; exit 64; }
manifest= sha= idem= verify=0
while (($#)); do case "$1" in --manifest) manifest=${2-};shift 2;;--sha) sha=${2-};shift 2;;--idempotency-key) idem=${2-};shift 2;;--verify) verify=1;shift;;*) usage;;esac; done
[[ $sha =~ ^[0-9a-f]{40}$ && $idem =~ ^[A-Za-z0-9._:-]{16,200}$ && -r $manifest && $(hostname) == gsp-noc2 ]] || usage
command -v jq docker curl sha256sum pm2 >/dev/null || exit 69
repo=$(jq -er .repository_sha "$manifest"); image=$(jq -er .image_digest "$manifest"); checksum=$(jq -er .binary_sha256 "$manifest")
[[ $repo == "$sha" && $image =~ ^sha256:[0-9a-f]{64}$ && $checksum =~ ^[0-9a-f]{64}$ ]] || exit 65
mkdir -p "$RECEIPTS"; receipt="$RECEIPTS/$idem.json"
if [[ -e $receipt ]]; then jq -e --arg s "$sha" --arg i "$image" --arg b "$checksum" '.requested_sha==$s and .image_digest==$i and .binary_sha256==$b' "$receipt" >/dev/null || exit 65; cat "$receipt"; exit; fi
current(){ docker inspect --format '{{.Config.Image}}' "$BACKEND"; }
check(){ [[ $(current) == "ghcr.io/timrecursify/multica-backend@$image" ]] && curl -fsS http://127.0.0.1:3001/health >/dev/null && "$DAEMON" version | grep -Fqx "$sha"; }
((verify)) && { check; exit; }
staged="$DAEMON.next"; [[ -f $staged && $(sha256sum "$staged"|awk '{print $1}') == "$checksum" ]] || exit 65
old_image=$(current); old_sum=$(sha256sum "$DAEMON"|awk '{print $1}'); backup="$DAEMON.rollback.$idem"
# Complete every read/check before either artifact mutates; backup and binary install are atomic renames.
cp -p "$DAEMON" "$backup"
rollback(){ mv -f "$backup" "$DAEMON"; docker pull "$old_image" >/dev/null; docker rm -f "$BACKEND" >/dev/null; docker run -d --name "$BACKEND" "$old_image" >/dev/null; [[ $(current) == "$old_image" ]] && "$DAEMON" version >/dev/null; }
trap rollback ERR
docker pull "ghcr.io/timrecursify/multica-backend@$image" >/dev/null
mv -f "$staged" "$DAEMON"; docker rm -f "$BACKEND" >/dev/null; docker run -d --name "$BACKEND" "ghcr.io/timrecursify/multica-backend@$image" >/dev/null; pm2 restart gsp-multica-worker >/dev/null
check; trap - ERR
tmp=$(mktemp "$RECEIPTS/.receipt.XXXXXX")
jq -n --arg requested_sha "$sha" --arg image_digest "$image" --arg binary_sha256 "$checksum" --arg prior_image "$old_image" --arg prior_binary_sha256 "$old_sum" --arg timestamp "$(date -u +%FT%TZ)" '{requested_sha:$requested_sha,image_digest:$image_digest,binary_sha256:$binary_sha256,prior_image:$prior_image,prior_binary_sha256:$prior_binary_sha256,timestamp:$timestamp}' >"$tmp"
mv -f "$tmp" "$receipt"; cat "$receipt"
