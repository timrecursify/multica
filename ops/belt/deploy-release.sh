#!/usr/bin/env bash
# Deploy one reviewed commit as an immutable, complete belt release.
set -euo pipefail

usage() { echo "usage: $0 --preflight|--apply|--rollback SHA" >&2; exit 64; }
[[ $# == 2 ]] || usage
mode="$1"; requested_sha="$2"
case "$mode" in --preflight|--apply|--rollback) ;; *) usage ;; esac
[[ "$requested_sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'full SHA required' >&2; exit 64; }
checkout="${MULTICA_CHECKOUT_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)}"
release_root="${MULTICA_RELEASE_ROOT:-/home/newadmin/gsp-multica-runtime/releases}"
receipt_root="${MULTICA_RECEIPT_ROOT:-/home/newadmin/gsp-multica-runtime/receipts}"
pm2_bin="${PM2_BIN:-pm2}"
actual_sha="$(git -C "$checkout" rev-parse HEAD)"
[[ "$actual_sha" == "$requested_sha" ]] || { echo "checkout SHA is $actual_sha, expected $requested_sha" >&2; exit 65; }
git -C "$checkout" diff --quiet && git -C "$checkout" diff --cached --quiet || { echo 'tracked checkout must be clean' >&2; exit 65; }
release="$release_root/$requested_sha"; ecosystem="$release/ops/belt/ecosystem.gsp-belt.config.js"
health() { "$pm2_bin" jlist | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{let a=JSON.parse(s), n=["gsp-multica-bridge","multica-relay-advance","gsp-multica-worker","multica-cicd-worker","multica-archiver"];process.exit(n.every(x=>{let p=a.find(y=>y.name===x);return p&&p.pm2_env.status==="online"&&p.pm2_env.pm_cwd===process.argv[1]})?0:1)})' "$release"; }
preflight() { [[ -f "$checkout/ops/belt/ecosystem.gsp-belt.config.js" && -x "$checkout/ops/belt/build-daemon-artifact.sh" ]] || { echo 'required belt files missing' >&2; exit 65; }; node --input-type=module -e 'let a=(await import(process.argv[1])).default.apps;if(a.length!==5||a.some(x=>!x.script.startsWith(process.argv[2])))process.exit(1)' "file://$checkout/ops/belt/ecosystem.gsp-belt.config.js" "$checkout"; }
if [[ "$mode" == --rollback ]]; then
  [[ -f "$ecosystem" ]] || { echo "release missing: $release" >&2; exit 66; }
  "$pm2_bin" startOrReload "$ecosystem" --update-env
  health || { echo 'rollback health failed' >&2; exit 67; }
  exit 0
fi
preflight
[[ "$mode" == --preflight ]] && { echo "preflight ok $requested_sha"; exit 0; }
[[ ! -e "$release" ]] || { echo "immutable release exists: $release" >&2; exit 65; }
mkdir -p -- "$release_root" "$receipt_root"
git -C "$checkout" worktree add --detach "$release" "$requested_sha"
"$release/ops/belt/build-daemon-artifact.sh" "artifacts"
chmod -R a-w "$release"
if ! "$pm2_bin" startOrReload "$ecosystem" --update-env || ! health; then
  prior_sha="${MULTICA_PRIOR_SHA:-}"
  if [[ "$prior_sha" =~ ^[0-9a-f]{40}$ && -f "$release_root/$prior_sha/ops/belt/ecosystem.gsp-belt.config.js" ]]; then
    "$pm2_bin" startOrReload "$release_root/$prior_sha/ops/belt/ecosystem.gsp-belt.config.js" --update-env || true
  fi
  echo 'apply health failed; prior release reload attempted' >&2; exit 67
fi
printf '{"source_sha":"%s","release":"%s","health":"ok"}\n' "$requested_sha" "$release" > "$receipt_root/belt-$requested_sha.json"
echo "$receipt_root/belt-$requested_sha.json"
