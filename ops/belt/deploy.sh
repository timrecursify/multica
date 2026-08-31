#!/usr/bin/env bash
set -Eeuo pipefail

mode="dry-run"
rollback_timestamp=""

case "${1:---dry-run}" in
  --dry-run)
    ;;
  --apply)
    mode="apply"
    ;;
  --rollback)
    mode="rollback"
    rollback_timestamp="${2:-}"
    ;;
  *)
    printf 'Usage: %s [--dry-run|--apply] | %s --rollback YYYYMMDDTHHMMSSZ\n' "$0" "$0" >&2
    exit 2
    ;;
esac

if [[ "$mode" != rollback && $# -gt 1 ]] ||
   [[ "$mode" == rollback && $# -ne 2 ]]; then
  printf 'Usage: %s [--dry-run|--apply] | %s --rollback YYYYMMDDTHHMMSSZ\n' "$0" "$0" >&2
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
  "$root_dir/parity/multica-relay-advance-daemon.cjs"
  "$root_dir/multica-cicd-worker.cjs"
  "$root_dir/belt-config-guard.sh"
  "$root_dir/multica-daemon-wrapper.sh"
  "$root_dir/ecosystem.gsp-belt.config.js"
  "$root_dir/multica-bundle.py"
  "$root_dir/RUNBOOK_SPEC_WORKER.md"
  "$root_dir/RUNBOOK_BUILD_WORKER.md"
  "$root_dir/WORKER_COMMON.md"
)

declare -a targets=(
  "$runtime_root/gsp-multica/multica-bridge.cjs"
  "$runtime_root/gsp-multica/guardrails.cjs"
  "$runtime_root/gsp-multica/parity/multica-relay-advance-daemon.cjs"
  "$runtime_root/multica-cicd-worker.cjs"
  "$runtime_root/tools/belt-config-guard.sh"
  "$runtime_root/gsp-multica/fleet/multica-daemon-wrapper.sh"
  "$runtime_root/gsp-multica/fleet/ecosystem.gsp-belt.config.js"
  "$runtime_root/tools/multica-bundle.py"
  "$runtime_root/multica-doctrine/RUNBOOK_SPEC_WORKER.md"
  "$runtime_root/multica-doctrine/RUNBOOK_BUILD_WORKER.md"
  "$runtime_root/multica-doctrine/WORKER_COMMON.md"
)

invalid=0
declare -a new_targets=()
for index in "${!sources[@]}"; do
  new_targets[$index]=0
  [[ "${targets[$index]}" == "$runtime_root/gsp-multica/guardrails.cjs" ]] && new_targets[$index]=1
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
  printf 'Rollback receipt: %s --rollback %s\n' "$0" "$timestamp"
fi
