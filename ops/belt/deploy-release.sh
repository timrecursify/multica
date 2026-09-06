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
source "$checkout/ops/belt/release-manifest.sh"
release_root="${MULTICA_RELEASE_ROOT:-/var/lib/gsp/gsp-multica-runtime/releases}"
receipt_root="${MULTICA_RECEIPT_ROOT:-/var/lib/gsp/gsp-multica-runtime/receipts}"
pm2_bin="${PM2_BIN:-pm2}"
actual_sha="$(git -C "$checkout" rev-parse HEAD)"
[[ "$actual_sha" == "$requested_sha" ]] || { echo "checkout SHA is $actual_sha, expected $requested_sha" >&2; exit 65; }
git -C "$checkout" diff --quiet && git -C "$checkout" diff --cached --quiet || { echo 'tracked checkout must be clean' >&2; exit 65; }
release="$release_root/$requested_sha"; ecosystem="$release/ops/belt/ecosystem.gsp-belt.config.js"
manifest=("${BELT_RELEASE_MANIFEST[@]}")
health() {
  local snapshot
  snapshot="$($pm2_bin jlist)" || { echo 'health: pm2 jlist failed' >&2; return 1; }
  RELEASE="$release" INCLUDE_WORKER="$include_worker" SKIP_CICD="$skip_cicd_worker" PM2_SNAPSHOT="$snapshot" node -e '
    const apps=JSON.parse(process.env.PM2_SNAPSHOT), release=process.env.RELEASE;
    const required=["gsp-multica-bridge","multica-relay-advance","multica-archiver"];
    if(process.env.INCLUDE_WORKER==="1") required.push("gsp-multica-worker");
    if(process.env.SKIP_CICD!=="1") required.push("multica-cicd-worker");
    const expected=`${release}/ops/gsp-belt/relay/multica-relay-advance-wrapper.sh`, byName=new Map(apps.map(a=>[a.name,a])); let ok=true;
    for(const name of required){const app=byName.get(name),e=app?.pm2_env||{}, pathOk=name!=="multica-relay-advance"||e.pm_exec_path===expected;
      if(!app||e.status!=="online"||e.pm_cwd!==release||!pathOk){console.error(`health: app=${name} status=${e.status||"missing"} pid=${app?.pid??"unknown"} exit_code=${e.exit_code??"unknown"} exit_signal=${e.exit_signal||"unknown"} restarts=${e.unstable_restarts??"unknown"} error_log=${e.pm_err_log_path||"unknown"} expected_script=${name==="multica-relay-advance"?expected:"release cwd"}`);ok=false;}}
    process.exit(ok?0:1);'
}
require_graph() { local tree="$1" src dep rel; for src in "${manifest[@]}"; do [[ "$src" == *.cjs ]] || continue; while IFS= read -r dep; do [[ "$dep" == ./* || "$dep" == ../* ]] || continue; rel="$(realpath -m --relative-to="$tree" "$tree/$(dirname "$src")/$dep")"; [[ -f "$tree/$rel" ]] || rel+='.cjs'; [[ -f "$tree/$rel" ]] || { echo "Missing manifest runtime dependency: $src requires $rel" >&2; return 65; }; done < <(grep -oE "require\\([[:space:]]*[\"'][^\"']+[\"'][[:space:]]*\\)" "$tree/$src" | sed -E "s/^require\\([[:space:]]*[\"']([^\"']+)[\"'][[:space:]]*\\)$/\\1/"); done; }
manifest_checksum() { local tree="$1"; (cd "$tree" && sha256sum "${manifest[@]}" | sha256sum | awk '{print $1}'); }
preflight() { local tree="$1"; [[ -x "$tree/ops/belt/build-daemon-artifact.sh" ]] || { echo 'required belt files missing' >&2; exit 65; }; for file in "${manifest[@]}"; do [[ -f "$tree/$file" ]] || { echo "missing release manifest file: $file" >&2; exit 65; }; done; require_graph "$tree"; node -e 'const fs=require("fs");const s=fs.readFileSync(process.argv[1],"utf8");if((s.match(/script:/g)||[]).length!==6 || !s.includes("multica-relay-advance-wrapper.sh"))process.exit(1)' "$tree/ops/belt/ecosystem.gsp-belt.config.js"; }
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
manifest_sha256="$(manifest_checksum "$release")"
printf '{"source_sha":"%s","manifest_sha256":"%s","credential_keys":["DATABASE_URL","RELAY_AGENT_SECRET","RELAY_OPERATOR_SECRET","MULTICA_WORKSPACE_ID"]}\n' "$requested_sha" "$manifest_sha256" > "$release/.gsp-belt-release.json"
"$release/ops/belt/build-daemon-artifact.sh" "artifacts"
"$checkout/ops/belt/normalize-release-permissions.sh" "$release"
if ! MULTICA_INCLUDE_WORKER="$include_worker" MULTICA_SKIP_CICD_WORKER="$skip_cicd_worker" "$pm2_bin" startOrReload "$ecosystem" --update-env || ! health; then
  prior_sha="${MULTICA_PRIOR_SHA:-}"
  if [[ "$prior_sha" =~ ^[0-9a-f]{40}$ && -f "$release_root/$prior_sha/ops/belt/ecosystem.gsp-belt.config.js" ]]; then
    MULTICA_INCLUDE_WORKER="$include_worker" MULTICA_SKIP_CICD_WORKER="$skip_cicd_worker" "$pm2_bin" startOrReload "$release_root/$prior_sha/ops/belt/ecosystem.gsp-belt.config.js" --update-env || true
  fi
  echo 'apply health failed; prior release reload attempted' >&2; exit 67
fi
printf '{"source_sha":"%s","release":"%s","manifest_sha256":"%s","credential_keys":["DATABASE_URL","RELAY_AGENT_SECRET","RELAY_OPERATOR_SECRET","MULTICA_WORKSPACE_ID"],"health":"ok"}\n' "$requested_sha" "$release" "$manifest_sha256" > "$receipt_root/belt-$requested_sha.json"
echo "$receipt_root/belt-$requested_sha.json"
