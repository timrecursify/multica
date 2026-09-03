#!/usr/bin/env bash
set -Eeuo pipefail
mode=dry-run rollback_timestamp= only_target= requested_commit=
while (( $# )); do case "$1" in --dry-run) mode=dry-run; shift;; --apply) mode=apply; shift;; --rollback) mode=rollback; rollback_timestamp="${2:-}"; shift 2;; --only) only_target="${2:-}"; shift 2;; --source-commit) requested_commit="${2:-}"; shift 2;; *) echo "Usage: $0 [--dry-run|--apply] --source-commit <40-char commit> [--only multica-cicd-worker] | $0 --rollback TIMESTAMP [--only multica-cicd-worker]" >&2; exit 2;; esac; done
[[ -z "$only_target" || "$only_target" == multica-cicd-worker ]] || { echo "Invalid --only target: $only_target" >&2; exit 2; }
if [[ "$mode" == rollback ]]; then [[ "$rollback_timestamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { echo "Invalid rollback timestamp" >&2; exit 2; }; else [[ "$requested_commit" =~ ^[0-9a-f]{40}$ ]] || { echo "An explicit full 40-character --source-commit is required" >&2; exit 2; }; fi
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"; repo_root="$(cd -- "$root_dir/../.." && pwd)"; runtime_root="${BELT_DEPLOY_RUNTIME_ROOT:-/home/newadmin}"; timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
declare -a source_rels=(ops/belt/multica-bridge.cjs ops/belt/guardrails.cjs ops/belt/parked-diagnosis.cjs ops/belt/parked-entry-audit.cjs ops/belt/parity/multica-relay-advance-daemon.cjs ops/belt/parity/relay-dead-rows.cjs ops/belt/multica-cicd-worker.cjs ops/belt/cicd-watchdog.cjs ops/belt/cicd-deploy-evidence.cjs ops/belt/multica-archiver.cjs ops/belt/belt-config-guard.sh ops/belt/multica-daemon-wrapper.sh ops/belt/ecosystem.gsp-belt.config.js ops/belt/multica-bundle.py ops/belt/RUNBOOK_SPEC_WORKER.md ops/belt/RUNBOOK_BUILD_WORKER.md ops/belt/RUNBOOK_QC_WORKER.md ops/belt/WORKER_COMMON.md ops/belt/relay-completion-admission.cjs ops/belt/qc-lane.cjs ops/belt/reconciler.cjs ops/belt/stage-outcome.cjs ops/belt/transition-policy.cjs ops/belt/stage-routing.cjs ops/belt/qc-strict-evidence.cjs ops/belt/stage-routing.json ops/belt/qc-verdict-policy.cjs)
declare -a targets=("$runtime_root/gsp-multica/multica-bridge.cjs" "$runtime_root/gsp-multica/guardrails.cjs" "$runtime_root/gsp-multica/parked-diagnosis.cjs" "$runtime_root/gsp-multica/parked-entry-audit.cjs" "$runtime_root/gsp-multica/parity/multica-relay-advance-daemon.cjs" "$runtime_root/gsp-multica/parity/relay-dead-rows.cjs" "$runtime_root/multica-cicd-worker.cjs" "$runtime_root/cicd-watchdog.cjs" "$runtime_root/cicd-deploy-evidence.cjs" "$runtime_root/multica-archiver.cjs" "$runtime_root/tools/belt-config-guard.sh" "$runtime_root/gsp-multica/fleet/multica-daemon-wrapper.sh" "$runtime_root/gsp-multica/fleet/ecosystem.gsp-belt.config.js" "$runtime_root/tools/multica-bundle.py" "$runtime_root/multica-doctrine/RUNBOOK_SPEC_WORKER.md" "$runtime_root/multica-doctrine/RUNBOOK_BUILD_WORKER.md" "$runtime_root/multica-doctrine/RUNBOOK_QC_WORKER.md" "$runtime_root/multica-doctrine/WORKER_COMMON.md" "$runtime_root/gsp-multica/relay-completion-admission.cjs" "$runtime_root/gsp-multica/qc-lane.cjs" "$runtime_root/gsp-multica/reconciler.cjs" "$runtime_root/gsp-multica/stage-outcome.cjs" "$runtime_root/gsp-multica/transition-policy.cjs" "$runtime_root/gsp-multica/stage-routing.cjs" "$runtime_root/gsp-multica/qc-strict-evidence.cjs" "$runtime_root/gsp-multica/stage-routing.json" "$runtime_root/gsp-multica/qc-verdict-policy.cjs")
selected() { [[ -z "$only_target" || "${source_rels[$1]##*/}" == "$only_target.cjs" ]]; }
md5() { [[ -f "$1" ]] && md5sum -- "$1" | awk '{print $1}'; }
last_deployed_sha() {
  local receipt_dir="$runtime_root/gsp-multica/deploy-receipts" receipt
  [[ -d "$receipt_dir" ]] || return 0
  for receipt in $(ls -1t "$receipt_dir"/belt-*.json 2>/dev/null); do
    node -e 'const r=require(process.argv[1]); if (r.outcome !== "refused" && r.source_sha) process.stdout.write(r.source_sha); else process.exit(1)' "$receipt" && return 0
  done
}
write_receipt() {
  local outcome="$1" detail="${2:-}" receipt_dir="$runtime_root/gsp-multica/deploy-receipts"
  mkdir -p -- "$receipt_dir"; receipt="$receipt_dir/belt-${timestamp}.json"
  printf '{"repo":"timrecursify/multica","requested_commit":"%s","resolved_commit":"%s","source_sha":"%s","outcome":"%s"%s}\n' "$requested_commit" "$resolved_commit" "$resolved_commit" "$outcome" "$detail" > "$receipt"
  echo "Receipt: $receipt"
}
source_tree=""; cleanup() { [[ -z "$source_tree" ]] || rm -rf -- "$source_tree"; }; trap cleanup EXIT
if [[ "$mode" != rollback ]]; then
  git -C "$repo_root" fetch --quiet origin main || { echo 'Could not refresh origin/main' >&2; exit 1; }
  resolved_commit="$(git -C "$repo_root" rev-parse --verify --quiet 'origin/main^{commit}')" || { echo 'origin/main is unavailable' >&2; exit 1; }
  source_tree="$(mktemp -d "${TMPDIR:-/tmp}/belt-source.XXXXXX")"
  git -C "$repo_root" archive --format=tar "$resolved_commit" | tar -x -C "$source_tree" || { echo "Could not materialize origin/main" >&2; exit 1; }
fi
invalid=0; declare -a staged_sources=() new_targets=(); declare -A manifest_indexes=()
for i in "${!source_rels[@]}"; do manifest_indexes["${source_rels[$i]}"]="$i"; staged_sources[$i]="$source_tree/${source_rels[$i]}"; done
for i in "${!source_rels[@]}"; do selected "$i" || continue; [[ "$mode" == rollback || "${source_rels[$i]}" != *.cjs || ! -f "${staged_sources[$i]}" ]] && continue; while IFS= read -r dep; do [[ "$dep" == ./* || "$dep" == ../* ]] || continue; rel="$(realpath -m --relative-to="$source_tree" "$source_tree/$(dirname "${source_rels[$i]}")/$dep")"; [[ "$rel" == *.cjs || -f "$source_tree/$rel" ]] || rel+='.cjs'; dep_i="${manifest_indexes[$rel]-}"; if [[ -z "$dep_i" ]]; then echo "Missing manifest runtime dependency: ${source_rels[$i]} requires $rel" >&2; invalid=1; elif ! selected "$dep_i" && [[ ! -f "${targets[$dep_i]}" ]]; then echo "Missing runtime dependency target: ${source_rels[$i]} requires ${targets[$dep_i]}" >&2; invalid=1; fi; done < <(grep -oE "require\\([[:space:]]*[\"'][^\"']+[\"'][[:space:]]*\\)" "${staged_sources[$i]}" | sed -E "s/^require\\([[:space:]]*[\"']([^\"']+)[\"'][[:space:]]*\\)$/\\1/"); done
for i in "${!targets[@]}"; do selected "$i" || continue; new_targets[$i]=0; [[ "${targets[$i]}" =~ /(guardrails|parked-diagnosis|parked-entry-audit|relay-dead-rows|cicd-watchdog)\.cjs$ || "${targets[$i]}" =~ /(cicd-deploy-evidence|relay-completion-admission|qc-lane|reconciler|stage-outcome|transition-policy|stage-routing|qc-strict-evidence|stage-routing.|qc-verdict-policy)\.cjs$ || "${targets[$i]}" =~ /stage-routing\.json$ ]] && new_targets[$i]=1; if [[ "$mode" != rollback && ! -f "${staged_sources[$i]}" ]]; then echo "Missing selected commit blob: ${source_rels[$i]}" >&2; invalid=1; fi; [[ "$mode" == rollback || -f "${targets[$i]}" || ${new_targets[$i]} -eq 1 ]] || { echo "Missing runtime file: ${targets[$i]}" >&2; invalid=1; }; [[ "$mode" != rollback || -f "${targets[$i]}.bak-${rollback_timestamp}" || -f "${targets[$i]}.bak-${rollback_timestamp}.absent" ]] || { echo "Missing rollback backup: ${targets[$i]}.bak-${rollback_timestamp}" >&2; invalid=1; }; done
(( ! invalid )) || exit 1
if [[ "$mode" == rollback ]]; then for i in "${!targets[@]}"; do selected "$i" || continue; [[ -f "${targets[$i]}.bak-${rollback_timestamp}.absent" ]] && rm -f -- "${targets[$i]}" || cp --preserve=mode -- "${targets[$i]}.bak-${rollback_timestamp}" "${targets[$i]}"; done; echo "Rollback complete for $rollback_timestamp."; exit 0; fi
last_sha="$(last_deployed_sha)"; declare -a decisions=()
for i in "${!targets[@]}"; do
  selected "$i" || continue
  live_md5="$(md5 "${targets[$i]}")"; main_md5="$(md5 "${staged_sources[$i]}")"; last_md5=
  [[ -z "$last_sha" ]] || last_md5="$({ git -C "$repo_root" show "$last_sha:${source_rels[$i]}" 2>/dev/null || true; } | md5sum | awk '{print $1}')"
  decisions[$i]="$(node -e "const {deploymentDecision}=require(process.argv[1]); process.stdout.write(deploymentDecision(JSON.parse(process.argv[2])))" "$root_dir/deploy-decision.cjs" "{\"live_md5\":\"$live_md5\",\"last_deployed_md5\":\"$last_md5\",\"main_md5\":\"$main_md5\"}")"
  if [[ "${decisions[$i]}" == refuse ]]; then [[ "$mode" != apply ]] || write_receipt refused ',"refused":"live_runtime_diverged"'; echo "refused: live_runtime_diverged ${targets[$i]}" >&2; exit 1; fi
done
if [[ "$mode" == apply ]] && ! printf '%s\n' "${decisions[@]}" | grep -qx deploy; then write_receipt noop; echo 'No-op: live runtime already equals origin/main.'; exit 0; fi
declare -a backups=() absence_markers=() touched=()
restore_on_failure() { local rc=$? i; if [[ "$mode" == apply && ${#touched[@]} -gt 0 ]]; then for i in "${touched[@]}"; do [[ -f "${absence_markers[$i]}" ]] && rm -f -- "${targets[$i]}" || cp --preserve=mode -- "${backups[$i]}" "${targets[$i]}" || echo "ROLLBACK FAILED: ${targets[$i]}" >&2; done; echo "Deployment failed; restored ${#touched[@]} target(s)." >&2; fi; exit "$rc"; }; trap restore_on_failure ERR
for i in "${!targets[@]}"; do selected "$i" && [[ "${decisions[$i]}" == deploy ]] || continue; backups[$i]="${targets[$i]}.bak-${timestamp}"; absence_markers[$i]="${backups[$i]}.absent"; if [[ "$mode" == dry-run ]]; then echo "Would back up ${targets[$i]} to ${backups[$i]}"; elif [[ -f "${targets[$i]}" ]]; then cp --preserve=mode -- "${targets[$i]}" "${backups[$i]}"; echo "Backed up ${targets[$i]} to ${backups[$i]}"; else : > "${absence_markers[$i]}"; echo "Backed up absence of new target ${targets[$i]}"; fi; done
for i in "${!targets[@]}"; do selected "$i" && [[ "${decisions[$i]}" == deploy ]] || continue; if [[ "$mode" == dry-run ]]; then echo "Would copy ${source_rels[$i]}@$resolved_commit to ${targets[$i]}"; continue; fi; touched+=("$i"); [[ "${BELT_DEPLOY_FAIL_INDEX:-}" != "$i" ]] || { echo "Injected deployment failure at index $i" >&2; false; }; cp --preserve=mode -- "${staged_sources[$i]}" "${targets[$i]}"; [[ "${BELT_DEPLOY_CORRUPT_INDEX:-}" != "$i" ]] || printf '\ncorrupted-after-copy\n' >> "${targets[$i]}"; cmp -s -- "${staged_sources[$i]}" "${targets[$i]}" || { echo "Post-copy mismatch: ${targets[$i]}" >&2; false; }; echo "Copied ${source_rels[$i]}@$resolved_commit to ${targets[$i]}"; done
if [[ "$mode" == apply ]]; then
  daemon_target="$runtime_root/gsp-multica/parity/multica-relay-advance-daemon.cjs"
  if [[ -f "$daemon_target" ]]; then
    node --check "$daemon_target" || { echo "Daemon syntax validation failed: $daemon_target" >&2; false; }
    node -e 'const Module=require("module"); const load=Module._load; Module._load=(request,parent,isMain)=>request==="pg"?{Pool:class { constructor() {} on() {} connect() { return Promise.reject(new Error("validation stub")); } query() { return Promise.resolve({rows:[]}); } end() {} }}:load(request,parent,isMain); require(process.argv[1])' "$daemon_target" || { echo "Daemon dependency validation failed: $daemon_target" >&2; false; }
  fi
fi
trap - ERR
if [[ "$mode" == apply ]]; then write_receipt deployed; echo "Rollback receipt: $0 --rollback $timestamp${only_target:+ --only $only_target}"; fi
echo 'No processes were restarted.'
