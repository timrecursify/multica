#!/usr/bin/env bash
set -Eeuo pipefail

mode="dry-run"
rollback_timestamp=""
only_target=""
source_commit=""

while (( $# )); do
  case "$1" in
    --dry-run) mode="dry-run"; shift ;;
    --apply) mode="apply"; shift ;;
    --rollback) mode="rollback"; rollback_timestamp="${2:-}"; shift 2 ;;
    --only) only_target="${2:-}"; shift 2 ;;
    --source-commit) source_commit="${2:-}"; shift 2 ;;
    *)
      printf 'Usage: %s [--dry-run|--apply] [--source-commit SHA] [--only TARGET] | %s --rollback YYYYMMDDTHHMMSSZ [--only TARGET]\n' "$0" "$0" >&2
      exit 2
      ;;
  esac
done

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [[ -n "$source_commit" && ! "$source_commit" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'Invalid source commit: %s\n' "$source_commit" >&2
  exit 2
fi
if [[ -n "$source_commit" ]]; then
  actual_commit="$(git -C "$root_dir/../.." rev-parse HEAD 2>/dev/null || true)"
  [[ "$actual_commit" == "$source_commit" ]] || { printf 'Source commit mismatch: checkout=%s requested=%s\n' "$actual_commit" "$source_commit" >&2; exit 2; }
fi

if [[ "$mode" == rollback && ! "$rollback_timestamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
  printf 'Invalid rollback timestamp: %s\n' "$rollback_timestamp" >&2
  exit 2
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
runtime_root="${BELT_DEPLOY_RUNTIME_ROOT:-/home/newadmin}"

declare -a sources=(
  "$root_dir/multica-bridge.cjs"
  "$root_dir/guardrails.cjs"
  "$root_dir/parked-diagnosis.cjs"
  "$root_dir/parked-entry-audit.cjs"
  "$root_dir/parity/multica-relay-advance-daemon.cjs"
  "$root_dir/parity/relay-dead-rows.cjs"
  "$root_dir/multica-cicd-worker.cjs"
  "$root_dir/cicd-deploy-evidence.cjs"
  "$root_dir/cicd-watchdog.cjs"
  "$root_dir/multica-archiver.cjs"
  "$root_dir/merged-pr-recovery-sweep.cjs"
  "$root_dir/belt-config-guard.sh"
  "$root_dir/belt-concurrency.sh"
  "$root_dir/multica-daemon-wrapper.sh"
  "$root_dir/ecosystem.gsp-belt.config.js"
  "$root_dir/multica-bundle.py"
  "$root_dir/RUNBOOK_SPEC_WORKER.md"
  "$root_dir/RUNBOOK_BUILD_WORKER.md"
  "$root_dir/RUNBOOK_QC_WORKER.md"
  "$root_dir/WORKER_COMMON.md"
  "$root_dir/relay-completion-admission.cjs"
  "$root_dir/qc-lane.cjs"
  "$root_dir/reconciler.cjs"
  "$root_dir/stage-outcome.cjs"
  "$root_dir/transition-policy.cjs"
  "$root_dir/stage-routing.cjs"
  "$root_dir/qc-strict-evidence.cjs"
  "$root_dir/stage-routing.json"
  "$root_dir/qc-verdict-policy.cjs"
)

declare -a targets=(
  "$runtime_root/gsp-multica/multica-bridge.cjs"
  "$runtime_root/gsp-multica/guardrails.cjs"
  "$runtime_root/gsp-multica/parked-diagnosis.cjs"
  "$runtime_root/gsp-multica/parked-entry-audit.cjs"
  "$runtime_root/gsp-multica/parity/multica-relay-advance-daemon.cjs"
  "$runtime_root/gsp-multica/parity/relay-dead-rows.cjs"
  "$runtime_root/multica-cicd-worker.cjs"
  "$runtime_root/cicd-deploy-evidence.cjs"
  "$runtime_root/cicd-watchdog.cjs"
  "$runtime_root/multica-archiver.cjs"
  "$runtime_root/merged-pr-recovery-sweep.cjs"
  "$runtime_root/tools/belt-config-guard.sh"
  "$runtime_root/tools/belt-concurrency.sh"
  "$runtime_root/gsp-multica/fleet/multica-daemon-wrapper.sh"
  "$runtime_root/gsp-multica/fleet/ecosystem.gsp-belt.config.js"
  "$runtime_root/tools/multica-bundle.py"
  "$runtime_root/multica-doctrine/RUNBOOK_SPEC_WORKER.md"
  "$runtime_root/multica-doctrine/RUNBOOK_BUILD_WORKER.md"
  "$runtime_root/multica-doctrine/RUNBOOK_QC_WORKER.md"
  "$runtime_root/multica-doctrine/WORKER_COMMON.md"
  "$runtime_root/gsp-multica/relay-completion-admission.cjs"
  "$runtime_root/gsp-multica/qc-lane.cjs"
  "$runtime_root/gsp-multica/reconciler.cjs"
  "$runtime_root/gsp-multica/stage-outcome.cjs"
  "$runtime_root/gsp-multica/transition-policy.cjs"
  "$runtime_root/gsp-multica/stage-routing.cjs"
  "$runtime_root/gsp-multica/qc-strict-evidence.cjs"
  "$runtime_root/gsp-multica/stage-routing.json"
  "$runtime_root/gsp-multica/qc-verdict-policy.cjs"
)

selected() {
  local name="${sources[$1]##*/}"
  [[ -z "$only_target" || "$name" == "$only_target" || "${name%.cjs}" == "$only_target" ]]
}

if [[ -n "$only_target" ]]; then
  found=0
  for source_file in "${sources[@]}"; do
    name="${source_file##*/}"
    if [[ "$name" == "$only_target" || "${name%.cjs}" == "$only_target" ]]; then found=1; break; fi
  done
  (( found )) || { printf 'Invalid --only target: %s\n' "$only_target" >&2; exit 2; }
fi

invalid=0
declare -a new_targets=()
declare -A manifest_indexes=()
for index in "${!sources[@]}"; do
  manifest_indexes["${sources[$index]}"]="$index"
done

# Validate wrapper rollout before creating backups or mutating any target. A
# drifted runtime wrapper is allowed when this deployment includes the wrapper
# (it will be repaired); selective deployments that omit it must fail closed.
for index in "${!sources[@]}"; do
  [[ "${sources[$index]}" == "$root_dir/multica-daemon-wrapper.sh" ]] || continue
  runtime_wrapper="${targets[$index]}"
  if ! selected "$index"; then
    if [[ -f "$runtime_wrapper" ]] && ! cmp -s "$root_dir/multica-daemon-wrapper.sh" "$runtime_wrapper"; then
      printf 'Wrapper preflight: source/runtime parity mismatch (wrapper not selected)\n' >&2
      exit 1
    fi
    continue
  fi
  if [[ -n "${MULTICA_DAEMON_MAX_CONCURRENT_TASKS:-}" ]]; then
    source "$root_dir/belt-concurrency.sh"
    cpu_count="$(belt_cpu_count)" || { printf 'Wrapper preflight: unable to determine CPU count\n' >&2; exit 1; }
    cap="${MULTICA_DAEMON_MAX_CONCURRENT_TASKS}"
    [[ "$cap" =~ ^[1-9][0-9]*$ ]] || { printf 'Wrapper preflight: MULTICA_DAEMON_MAX_CONCURRENT_TASKS must be a positive integer\n' >&2; exit 1; }
    (( cap <= cpu_count )) || { printf 'Wrapper preflight: MULTICA_DAEMON_MAX_CONCURRENT_TASKS=%s exceeds CPU count=%s\n' "$cap" "$cpu_count" >&2; exit 1; }
  fi
done

# Validate every relative CommonJS require before any backup or copy. This
# keeps the manifest closed under runtime dependencies, so a missing module
# fails the deploy before the first target is touched.
for index in "${!sources[@]}"; do
  selected "$index" || continue
  source_file="${sources[$index]}"
  [[ -f "$source_file" ]] || continue
  case "$source_file" in
    *.cjs|*.js)
      while IFS= read -r dependency; do
        [[ "$dependency" == ./* || "$dependency" == ../* ]] || continue
        dependency_file="$(dirname -- "$source_file")/$dependency"
        if [[ ! -f "$dependency_file" ]]; then
          if [[ -f "${dependency_file}.cjs" ]]; then
            dependency_file="${dependency_file}.cjs"
          elif [[ -f "${dependency_file}.js" ]]; then
            dependency_file="${dependency_file}.js"
          fi
        fi
        dependency_file="$(cd -- "$(dirname -- "$dependency_file")" && pwd)/$(basename -- "$dependency_file")"
        dependency_index="${manifest_indexes[$dependency_file]-}"
        if [[ -z "$dependency_index" ]]; then
          printf 'Missing manifest runtime dependency: %s requires %s\n' "$source_file" "$dependency_file" >&2
          invalid=1
        elif [[ -z "$only_target" ]] && ! selected "$dependency_index" && [[ ! -f "${targets[$dependency_index]}" ]]; then
          printf 'Missing runtime dependency target: %s requires %s\n' "$source_file" "${targets[$dependency_index]}" >&2
          invalid=1
        fi
      done < <(grep -oE "require\([[:space:]]*[\"'][^\"']+[\"'][[:space:]]*\)" "$source_file" |
        sed -E "s/^require\([[:space:]]*[\"']([^\"']+)[\"'][[:space:]]*\)$/\1/")
      ;;
  esac
done

for index in "${!sources[@]}"; do
  selected "$index" || continue
  new_targets[$index]=0
  [[ "${targets[$index]}" == "$runtime_root/gsp-multica/guardrails.cjs" ||
      "${targets[$index]}" == "$runtime_root/gsp-multica/parked-diagnosis.cjs" ||
      "${targets[$index]}" == "$runtime_root/gsp-multica/parked-entry-audit.cjs" ||
      "${targets[$index]}" == "$runtime_root/gsp-multica/parity/relay-dead-rows.cjs" ||
      "${targets[$index]}" == "$runtime_root/cicd-deploy-evidence.cjs" ||
      "${targets[$index]}" == "$runtime_root/cicd-watchdog.cjs" ||
      "${targets[$index]}" == "$runtime_root/merged-pr-recovery-sweep.cjs" ||
      "${targets[$index]}" == "$runtime_root/gsp-multica/relay-completion-admission.cjs" ]] && new_targets[$index]=1
  # The wrapper is part of the runtime/source parity contract.  A previous
  # deployment may have left it absent (for example after a partial rollout),
  # so allow this deployment to create the named target instead of rejecting
  # the release before the parity repair can run.
  [[ "${targets[$index]}" == "$runtime_root/gsp-multica/fleet/multica-daemon-wrapper.sh" ]] && new_targets[$index]=1
  [[ "${targets[$index]}" == "$runtime_root/tools/belt-concurrency.sh" ]] && new_targets[$index]=1
  [[ "${targets[$index]}" =~ /(qc-lane|reconciler|stage-outcome|transition-policy|stage-routing|qc-strict-evidence|qc-verdict-policy)\.cjs$ ||
      "${targets[$index]}" == "$runtime_root/gsp-multica/stage-routing.json" ]] && new_targets[$index]=1
  if [[ ! -f "${sources[$index]}" ]]; then
    printf 'Missing repository file: %s\n' "${sources[$index]}" >&2
    invalid=1
  fi
  if [[ ! -f "${targets[$index]}" && ${new_targets[$index]} -eq 0 ]]; then
    printf 'Missing runtime file: %s\n' "${targets[$index]}" >&2
    invalid=1
  fi
  if [[ "$mode" == rollback && ! -f "${targets[$index]}.bak-${rollback_timestamp}" &&
        ! -f "${targets[$index]}.bak-${rollback_timestamp}.absent" ]]; then
    printf 'Missing rollback backup: %s.bak-%s\n' "${targets[$index]}" "$rollback_timestamp" >&2
    invalid=1
  fi
done

if (( invalid )); then
  exit 1
fi

if [[ "$mode" == rollback ]]; then
  for index in "${!targets[@]}"; do
    selected "$index" || continue
    if [[ -f "${targets[$index]}.bak-${rollback_timestamp}.absent" ]]; then
      rm -f -- "${targets[$index]}"
      printf 'Removed new target %s\n' "${targets[$index]}"
    else
      cp --preserve=mode -- "${targets[$index]}.bak-${rollback_timestamp}" "${targets[$index]}"
      printf 'Restored %s from %s.bak-%s\n' "${targets[$index]}" "${targets[$index]}" "$rollback_timestamp"
    fi
  done
  printf 'Rollback complete for %s.\n' "$rollback_timestamp"
  exit 0
fi

declare -a backups=()
declare -a touched=()
declare -a absence_markers=()
restore_on_failure() {
  local rc=$? index
  if [[ "$mode" == apply && ${#touched[@]} -gt 0 ]]; then
    for index in "${touched[@]}"; do
      if [[ -f "${absence_markers[$index]}" ]]; then
        rm -f -- "${targets[$index]}"
      else
        cp --preserve=mode -- "${backups[$index]}" "${targets[$index]}" ||
          printf 'ROLLBACK FAILED: %s\n' "${targets[$index]}" >&2
      fi
    done
    printf 'Deployment failed; restored %s target(s). Rollback receipt: %s --rollback %s\n' \
      "${#touched[@]}" "$0" "$timestamp" >&2
  fi
  exit "$rc"
}
trap restore_on_failure ERR

# Create every backup before the first target is modified. A partial backup set
# cannot produce a misleading rollback claim.
for index in "${!targets[@]}"; do
  selected "$index" || continue
  source_file="${sources[$index]}"
  target_file="${targets[$index]}"
  backup_file="${target_file}.bak-${timestamp}"
  backups[$index]="$backup_file"
  absence_markers[$index]="${backup_file}.absent"
  if [[ "$mode" == dry-run ]]; then
    printf 'Would back up %s to %s\n' "$target_file" "$backup_file"
  else
    if [[ -f "$target_file" ]]; then
      cp --preserve=mode -- "$target_file" "$backup_file"
      printf 'Backed up %s to %s\n' "$target_file" "$backup_file"
    else
      : > "${absence_markers[$index]}"
      printf 'Backed up absence of new target %s to %s\n' "$target_file" "${absence_markers[$index]}"
    fi
  fi
done

for index in "${!sources[@]}"; do
  selected "$index" || continue
  source_file="${sources[$index]}"
  target_file="${targets[$index]}"
  if [[ "$mode" == dry-run ]]; then
    printf 'Would copy %s to %s\n' "$source_file" "$target_file"
    continue
  fi
  touched+=("$index")
  if [[ "${BELT_DEPLOY_FAIL_INDEX:-}" == "$index" ]]; then
    printf 'Injected deployment failure at index %s\n' "$index" >&2
    false
  fi
  cp --preserve=mode -- "$source_file" "$target_file"
  printf 'Copied %s to %s\n' "$source_file" "$target_file"
done

# Verify the deployed set after copying. Any mismatch is treated as a failed
# deployment so the existing ERR trap restores every touched target.
if [[ "$mode" == apply ]]; then
  for index in "${!sources[@]}"; do
    selected "$index" || continue
    if ! cmp -s -- "${sources[$index]}" "${targets[$index]}"; then
      printf 'Post-deploy parity mismatch: %s != %s\n' "${sources[$index]}" "${targets[$index]}" >&2
      false
    fi
  done
fi

trap - ERR
if [[ "$mode" == apply ]]; then
  receipt_dir="$runtime_root/gsp-multica/deploy-receipts"
  mkdir -p -- "$receipt_dir"
  source_sha="$(git -C "$root_dir/../.." rev-parse HEAD)"
  manifest_sha256="$(sha256sum "${sources[@]}" | sha256sum | awk '{print $1}')"
  receipt="$receipt_dir/belt-${timestamp}.json"
  printf '{"repo":"timrecursify/multica","source_sha":"%s","manifest_sha256":"%s","credential_keys":["DATABASE_URL","RELAY_AGENT_SECRET","RELAY_OPERATOR_SECRET","MULTICA_WORKSPACE_ID"]}\n' "$source_sha" "$manifest_sha256" > "$receipt"
  printf 'Receipt: %s\n' "$receipt"
fi
printf 'No processes were restarted.\n'
if [[ "$mode" == apply ]]; then
  printf 'Rollback receipt: %s --rollback %s' "$0" "$timestamp"
  [[ -n "$only_target" ]] && printf ' --only %s' "$only_target"
  printf '\n'
fi
