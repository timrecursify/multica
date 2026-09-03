#!/usr/bin/env bash
# Audited fixed-target primitive; the audited sk command fetches and stages artifacts.
set -Eeuo pipefail
BACKEND=multica-backend DAEMON=/home/newadmin/multica-daemon/server RECEIPTS=/var/lib/multica/noc2-receipts
DAEMON_APP=gsp-multica-worker
BACKEND_ARGS_FILE=/etc/multica/multica-backend.run
usage(){ echo "usage: $0 --manifest FILE --sha SHA --idempotency-key KEY [--verify]" >&2; exit 64; }
manifest= sha= idem= verify=0
while (($#)); do case "$1" in --manifest) manifest=${2-};shift 2;;--sha) sha=${2-};shift 2;;--idempotency-key) idem=${2-};shift 2;;--verify) verify=1;shift;;*) usage;;esac; done
[[ $sha =~ ^[0-9a-f]{40}$ && $idem =~ ^[A-Za-z0-9._:-]{16,200}$ && -r $manifest && $(hostname) == gsp-noc2 ]] || usage
command -v jq docker curl sha256sum pm2 node >/dev/null || exit 69
repo=$(jq -er .repository_sha "$manifest"); image=$(jq -er .image_digest "$manifest"); checksum=$(jq -er .binary_sha256 "$manifest")
[[ $repo == "$sha" && $image =~ ^sha256:[0-9a-f]{64}$ && $checksum =~ ^[0-9a-f]{64}$ ]] || exit 65
mkdir -p "$RECEIPTS"; receipt="$RECEIPTS/$idem.json"
if [[ -e $receipt ]]; then jq -e --arg s "$sha" --arg i "$image" --arg b "$checksum" '.requested_sha==$s and .image_digest==$i and .binary_sha256==$b' "$receipt" >/dev/null || exit 65; cat "$receipt"; exit; fi
canonical="ghcr.io/timrecursify/multica-backend@$image"
current(){ docker inspect --format '{{.Config.Image}}' "$BACKEND"; }
daemon_state(){ pm2 jlist | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{let p=JSON.parse(s).find(x=>x.name===process.argv[1]);if(!p)process.exit(2);console.log([p.pid,p.pm2_env.status].join("|"))})' "$DAEMON_APP"; }
check(){
  [[ $(current) == "$canonical" ]] && curl -fsS http://127.0.0.1:3001/health >/dev/null || return 1
  local state pid status; state=$(daemon_state) || return 1; IFS='|' read -r pid status <<<"$state"
  [[ $status == online && $pid =~ ^[1-9][0-9]*$ && -r /proc/$pid/cmdline && -e /proc/$pid/exe ]] || return 1
  local -a argv=(); mapfile -d '' -t argv < "/proc/$pid/cmdline"
  [[ ${argv[0]-} == "$DAEMON" && ${argv[1]-} == daemon && ${argv[2]-} == start ]] || return 1
  local n=0 a; for a in "${argv[@]}"; do [[ $a == --max-concurrent-tasks=32 ]] && ((n+=1)); done; [[ $n == 1 ]] || return 1
  [[ $(sha256sum /proc/$pid/exe|awk '{print $1}') == "$checksum" ]] || return 1
  "$DAEMON" version --output json | jq -e --arg s "$sha" '.commit==$s' >/dev/null
}
((verify)) && { check; exit; }
staged="$DAEMON.next"; [[ -f $staged && $(sha256sum "$staged"|awk '{print $1}') == "$checksum" ]] || exit 65
[[ -r $BACKEND_ARGS_FILE && ! -L $BACKEND_ARGS_FILE ]] || exit 65
mapfile -t backend_args < "$BACKEND_ARGS_FILE"; ((${#backend_args[@]} > 0)) || exit 65
old_image=$(current); old_sum=$(sha256sum "$DAEMON"|awk '{print $1}'); backup="$DAEMON.rollback.$idem"
# Complete every read/check before either artifact mutates; backup and binary install are atomic renames.
cp -p "$DAEMON" "$backup"
rollback_check(){
  [[ $(current) == "$old_image" ]] || return 1
  curl -fsS http://127.0.0.1:3001/health >/dev/null || return 1
  local state pid status; state=$(daemon_state) || return 1; IFS='|' read -r pid status <<<"$state"
  [[ $status == online && $pid =~ ^[1-9][0-9]*$ && -r /proc/$pid/cmdline ]] || return 1
  local -a argv=(); mapfile -d '' -t argv < "/proc/$pid/cmdline"
  [[ ${argv[0]-} == "$DAEMON" && ${argv[1]-} == daemon && ${argv[2]-} == start ]] || return 1
  local n=0 a; for a in "${argv[@]}"; do [[ $a == --max-concurrent-tasks=32 ]] && ((n+=1)); done
  [[ $n == 1 && $(sha256sum /proc/$pid/exe|awk '{print $1}') == "$old_sum" ]]
}
rollback(){ local rc=$?; set +e; mv -f "$backup" "$DAEMON"; docker rm -f "$BACKEND" >/dev/null 2>&1 || true; docker create --name "$BACKEND" "${backend_args[@]}" "$old_image" >/dev/null && docker start "$BACKEND" >/dev/null; pm2 reload "$DAEMON_APP" --update-env >/dev/null 2>&1 && rollback_check || { echo 'rollback verification failed' >&2; rc=79; }; exit "$rc"; }
trap rollback ERR
docker pull "$canonical" >/dev/null
mv -f "$staged" "$DAEMON"; docker rm -f "$BACKEND" >/dev/null; docker create --name "$BACKEND" "${backend_args[@]}" "$canonical" >/dev/null; docker start "$BACKEND" >/dev/null; pm2 reload "$DAEMON_APP" --update-env >/dev/null
check; trap - ERR
tmp=$(mktemp "$RECEIPTS/.receipt.XXXXXX")
jq -n --arg requested_sha "$sha" --arg image_digest "$image" --arg binary_sha256 "$checksum" --arg prior_image "$old_image" --arg prior_binary_sha256 "$old_sum" --arg timestamp "$(date -u +%FT%TZ)" '{requested_sha:$requested_sha,image_digest:$image_digest,binary_sha256:$binary_sha256,prior_image:$prior_image,prior_binary_sha256:$prior_binary_sha256,timestamp:$timestamp}' >"$tmp"
mv -f "$tmp" "$receipt"; cat "$receipt"
