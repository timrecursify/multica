#!/usr/bin/env bash
set -Eeuo pipefail

mode="dry-run"
rollback_timestamp=""
only_target=""

while (( $# )); do
  case "$1" in
    --dry-run) mode="dry-run"; shift ;;
    --apply) mode="apply"; shift ;;
    --rollback) mode="rollback"; rollback_timestamp="${2:-}"; shift 2 ;;
    --only) only_target="${2:-}"; shift 2 ;;
    *)
      printf 'Usage: %s [--dry-run|--apply] [--only multica-cicd-worker] | %s --rollback YYYYMMDDTHHMMSSZ [--only multica-cicd-worker]\n' "$0" "$0" >&2
      exit 2
      ;;
  esac
done

if [[ -n "$only_target" && "$only_target" != multica-cicd-worker ]]; then
  printf 'Invalid --only target: %s\n' "$only_target" >&2
  exit 2
fi
if [[ "$mode" == rollback && ! "$rollback_timestamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
  printf 'Invalid rollback timestamp: %s\n' "$rollback_timestamp" >&2
  exit 2
fi

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
runtime_root="${BELT_DEPLOY_RUNTIME_ROOT:-/home/newadmin}"

declare -a sources=(
  "$root_dir/multica-bridge.cjs"
  "$root_dir/guardrails.cjs"
  "$root_dir/parked-diagnosis.cjs"
  "$root_dir/parity/multica-relay-advance-daemon.cjs"
  "$root_dir/multica-cicd-worker.cjs"
  "$root_dir/belt-config-guard.sh"
  "$root_dir/multica-daemon-wrapper.sh"
  "$root_dir/ecosystem.gsp-belt.config.js"
  "$root_dir/multica-bundle.py"
  "$root_dir/RUNBOOK_SPEC_WORKER.md"
  "$root_dir/RUNBOOK_BUILD_WORKER.md"
  "$root_dir/WORKER_COMMON.md"
  "$root_dir/relay-completion-admission.cjs"
)

declare -a targets=(
  "$runtime_root/gsp-multica/multica-bridge.cjs"
  "$runtime_root/gsp-multica/guardrails.cjs"
  "$runtime_root/gsp-multica/parked-diagnosis.cjs"
  "$runtime_root/gsp-multica/parity/multica-relay-advance-daemon.cjs"
  "$runtime_root/multica-cicd-worker.cjs"
  "$runtime_root/tools/belt-config-guard.sh"
  "$runtime_root/gsp-multica/fleet/multica-daemon-wrapper.sh"
  "$runtime_root/gsp-multica/fleet/ecosystem.gsp-belt.config.js"
  "$runtime_root/tools/multica-bundle.py"
  "$runtime_root/multica-doctrine/RUNBOOK_SPEC_WORKER.md"
  "$runtime_root/multica-doctrine/RUNBOOK_BUILD_WORKER.md"
  "$runtime_root/multica-doctrine/WORKER_COMMON.md"
  "$runtime_root/gsp-multica/relay-completion-admission.cjs"
)

selected() {
  [[ -z "$only_target" || ( "$only_target" == multica-cicd-worker && "$1" -eq 4 ) ]]
}

invalid=0
declare -a new_targets=()
declare -A manifest_indexes=()
for index in "${!sources[@]}"; do
  manifest_indexes["${sources[$index]}"]="$index"
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
        elif ! selected "$dependency_index" && [[ ! -f "${targets[$dependency_index]}" ]]; then
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
     "${targets[$index]}" == "$runtime_root/gsp-multica/relay-completion-admission.cjs" ]] && new_targets[$index]=1
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

trap - ERR
printf 'No processes were restarted.\n'
if [[ "$mode" == apply ]]; then
  printf 'Rollback receipt: %s --rollback %s' "$0" "$timestamp"
  [[ -n "$only_target" ]] && printf ' --only %s' "$only_target"
  printf '\n'
fi
