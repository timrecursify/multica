#!/usr/bin/env bash
# Deploy one reviewed commit as an immutable, complete belt release.
set -euo pipefail

usage() { echo "usage: $0 --preflight|--apply|--rollback SHA [--include-worker] [--skip-cicd-worker]" >&2; exit 64; }
[[ $# -ge 2 ]] || usage
mode="$1"; requested_sha="$2"; shift 2
case "$mode" in --preflight|--apply|--rollback) ;; *) usage ;; esac
[[ "$requested_sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'full SHA required' >&2; exit 64; }
include_worker=0; skip_cicd_worker=0
while [[ $# -gt 0 ]]; do case "$1" in
  --include-worker) include_worker=1 ;;
  --skip-cicd-worker) skip_cicd_worker=1 ;;
  *) usage ;;
esac; shift; done
checkout="${MULTICA_CHECKOUT_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)}"
release_root="${MULTICA_RELEASE_ROOT:-/home/newadmin/gsp-multica-runtime/releases}"
receipt_root="${MULTICA_RECEIPT_ROOT:-/home/newadmin/gsp-multica-runtime/receipts}"
pm2_bin="${PM2_BIN:-pm2}"
actual_sha="$(git -C "$checkout" rev-parse HEAD)"
[[ "$actual_sha" == "$requested_sha" ]] || { echo "checkout SHA is $actual_sha, expected $requested_sha" >&2; exit 65; }
git -C "$checkout" diff --quiet && git -C "$checkout" diff --cached --quiet || { echo 'tracked checkout must be clean' >&2; exit 65; }
release="$release_root/$requested_sha"; ecosystem="$release/ops/belt/ecosystem.gsp-belt.config.js"
manifest=(ops/belt/multica-bridge.cjs ops/belt/guardrails.cjs ops/belt/parked-diagnosis.cjs ops/belt/parked-entry-audit.cjs ops/belt/parity/multica-relay-advance-daemon.cjs ops/belt/parity/relay-dead-rows.cjs ops/belt/multica-cicd-worker.cjs ops/belt/cicd-deploy-evidence.cjs ops/belt/multica-archiver.cjs ops/belt/belt-config-guard.sh ops/belt/multica-daemon-wrapper.sh ops/belt/ecosystem.gsp-belt.config.js ops/belt/multica-bundle.py ops/belt/RUNBOOK_SPEC_WORKER.md ops/belt/RUNBOOK_BUILD_WORKER.md ops/belt/RUNBOOK_QC_WORKER.md ops/belt/WORKER_COMMON.md ops/belt/relay-completion-admission.cjs)
health() { "$pm2_bin" jlist | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{let a=JSON.parse(s),n=["gsp-multica-bridge","multica-relay-advance","multica-archiver"];if(process.argv[2]==="1")n.push("gsp-multica-worker");if(process.argv[3]!=="1")n.push("multica-cicd-worker");process.exit(n.every(x=>{let p=a.find(y=>y.name===x);return p&&p.pm2_env.status==="online"&&p.pm2_env.pm_cwd===process.argv[1]})?0:1)})' "$release" "$include_worker" "$skip_cicd_worker"; }
require_graph() { local tree="$1" src dep rel; for src in "${manifest[@]}"; do [[ "$src" == *.cjs ]] || continue; while IFS= read -r dep; do [[ "$dep" == ./* || "$dep" == ../* ]] || continue; rel="$(realpath -m --relative-to="$tree" "$tree/$(dirname "$src")/$dep")"; [[ -f "$tree/$rel" ]] || rel+='.cjs'; [[ -f "$tree/$rel" ]] || { echo "Missing manifest runtime dependency: $src requires $rel" >&2; return 65; }; done < <(grep -oE "require\\([[:space:]]*[\"'][^\"']+[\"'][[:space:]]*\\)" "$tree/$src" | sed -E "s/^require\\([[:space:]]*[\"']([^\"']+)[\"'][[:space:]]*\\)$/\\1/"); done; }
preflight() { local tree="$1"; [[ -x "$tree/ops/belt/build-daemon-artifact.sh" ]] || { echo 'required belt files missing' >&2; exit 65; }; for file in "${manifest[@]}"; do [[ -f "$tree/$file" ]] || { echo "missing release manifest file: $file" >&2; exit 65; }; done; require_graph "$tree"; node --check "$tree/ops/belt/parity/multica-relay-advance-daemon.cjs"; node -e 'require(process.argv[1])' "$tree/ops/belt/parity/multica-relay-advance-daemon.cjs"; node --input-type=module -e 'let a=(await import(process.argv[1])).default.apps;if(a.length!==5||a.some(x=>!x.script.startsWith(process.argv[2])))process.exit(1)' "file://$tree/ops/belt/ecosystem.gsp-belt.config.js" "$tree"; }
if [[ "$mode" == --rollback ]]; then
  [[ -f "$ecosystem" ]] || { echo "release missing: $release" >&2; exit 66; }
  MULTICA_INCLUDE_WORKER="$include_worker" MULTICA_SKIP_CICD_WORKER="$skip_cicd_worker" "$pm2_bin" startOrReload "$ecosystem" --update-env
  health || { echo 'rollback health failed' >&2; exit 67; }
  exit 0
fi
preflight "$checkout"
[[ "$mode" == --preflight ]] && { echo "preflight ok $requested_sha"; exit 0; }
[[ ! -e "$release" ]] || { echo "immutable release exists: $release" >&2; exit 65; }
mkdir -p -- "$release_root" "$receipt_root"
git -C "$checkout" worktree add --detach "$release" "$requested_sha"
preflight "$release"
"$release/ops/belt/build-daemon-artifact.sh" "artifacts"
chmod -R a-w "$release"
if ! MULTICA_INCLUDE_WORKER="$include_worker" MULTICA_SKIP_CICD_WORKER="$skip_cicd_worker" "$pm2_bin" startOrReload "$ecosystem" --update-env || ! health; then
  prior_sha="${MULTICA_PRIOR_SHA:-}"
  if [[ "$prior_sha" =~ ^[0-9a-f]{40}$ && -f "$release_root/$prior_sha/ops/belt/ecosystem.gsp-belt.config.js" ]]; then
    MULTICA_INCLUDE_WORKER="$include_worker" MULTICA_SKIP_CICD_WORKER="$skip_cicd_worker" "$pm2_bin" startOrReload "$release_root/$prior_sha/ops/belt/ecosystem.gsp-belt.config.js" --update-env || true
  fi
  echo 'apply health failed; prior release reload attempted' >&2; exit 67
fi
printf '{"source_sha":"%s","release":"%s","health":"ok"}\n' "$requested_sha" "$release" > "$receipt_root/belt-$requested_sha.json"
echo "$receipt_root/belt-$requested_sha.json"
