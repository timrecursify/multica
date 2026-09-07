#!/usr/bin/env bash
set -Eeuo pipefail

mode="dry-run"
rollback_timestamp=""
only_target=""
source_commit=""
allow_full=0
restart_enabled=1

while (( $# )); do
  case "$1" in
    --dry-run) mode="dry-run"; shift ;;
    --apply) mode="apply"; shift ;;
    --rollback) mode="rollback"; rollback_timestamp="${2:-}"; shift 2 ;;
    --only) only_target="${2:-}"; shift 2 ;;
    --all) allow_full=1; shift ;;
    --source-commit) source_commit="${2:-}"; shift 2 ;;
    --no-restart) restart_enabled=0; shift ;;
    *)
      printf 'Usage: %s [--dry-run|--apply] [--all] [--source-commit SHA] [--only TARGET] [--no-restart] | %s --rollback YYYYMMDDTHHMMSSZ [--only TARGET]\n' "$0" "$0" >&2
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

if [[ "$only_target" == belt-unit-guard ]]; then
  [[ "$mode" != rollback ]] || { printf 'belt-unit-guard rollback is not supported\n' >&2; exit 2; }
  "$root_dir/../gsp-belt/scripts/deploy-belt-unit-guard.sh" "$mode" "$source_commit"
  exit
fi

# A bare --apply would rewrite every managed target at once. Runtime and tracked
# tree have drifted independently, so an unscoped apply must be asked for by name.
if [[ "$mode" == apply && -z "$only_target" && $allow_full -eq 0 ]]; then
  printf 'Refusing an unscoped --apply: pass --only TARGET, or --all to deploy every managed file.\n' >&2
  exit 2
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
runtime_root="${BELT_DEPLOY_RUNTIME_ROOT:-/opt/gsp/multica-workers}"

# Manifest lives in one place; see belt-manifest.sh.
. "$root_dir/belt-manifest.sh"

selected() {
  local name="${sources[$1]##*/}"
  [[ -z "$only_target" || "$name" == "$only_target" || "${name%.cjs}" == "$only_target" ]]
}

# Resolve units from each manifest target's runtime service root. The worker
# root is shared by the GSP and PPP worker units; all other roots are one-to-one.
service_units_for_target() {
  local target="$1" relative service_root
  relative="${target#"$runtime_root"/}"
  [[ "$relative" != "$target" ]] || return 1
  service_root="${relative%%/*}"
  case "$service_root" in
    gsp-multica-bridge) printf '%s\n' gsp-multica-bridge ;;
    multica-relay-advance) printf '%s\n' multica-relay-advance ;;
    multica-cicd-worker) printf '%s\n' multica-cicd-worker ;;
    multica-archiver) printf '%s\n' multica-archiver ;;
    gsp-multica-worker) printf '%s\n' gsp-multica-worker gsp-multica-worker-ppp ;;
    *) return 1 ;;
  esac
}

print_restart_journal() {
  local unit="$1"
  printf '%s\n' "Last journal lines for $unit:" >&2
  journalctl -u "$unit" -n 40 --no-pager >&2 ||
    printf 'Unable to read journal for %s\n' "$unit" >&2
}

declare -a restarted_units=()
declare -a restarted_pids=()
restart_unit() {
  local unit="$1" old_pid state_output key value
  local new_pid="" substate="" active_enter="" active=0
  if ! old_pid="$(systemctl show --value -p MainPID "$unit")"; then
    printf 'Restart preflight failed: %s MainPID unavailable\n' "$unit" >&2
    print_restart_journal "$unit"
    return 1
  fi
  if ! sudo -n /bin/bash -c 'systemctl restart "$1"' belt-deploy "$unit"; then
    printf 'Restart command failed: %s old_pid=%s\n' "$unit" "$old_pid" >&2
    print_restart_journal "$unit"
    return 1
  fi
  if ! state_output="$(systemctl show -p MainPID -p SubState -p ActiveEnterTimestamp "$unit")"; then
    printf 'Restart verification failed: %s systemctl show failed\n' "$unit" >&2
    print_restart_journal "$unit"
    return 1
  fi
  while IFS='=' read -r key value; do
    case "$key" in
      MainPID) new_pid="$value" ;;
      SubState) substate="$value" ;;
      ActiveEnterTimestamp) active_enter="$value" ;;
    esac
  done <<< "$state_output"
  systemctl is-active --quiet "$unit" && active=1
  if (( ! active )) || [[ ! "$new_pid" =~ ^[1-9][0-9]*$ || "$new_pid" == "$old_pid" || "$substate" != running ]]; then
    printf 'Restart verification failed: %s old_pid=%s new_pid=%s substate=%s active_enter=%s\n' \
      "$unit" "$old_pid" "${new_pid:-unknown}" "${substate:-unknown}" "${active_enter:-unknown}" >&2
    print_restart_journal "$unit"
    return 1
  fi
  printf 'Restarted %s: %s -> %s substate=%s active_enter=%s\n' \
    "$unit" "$old_pid" "$new_pid" "$substate" "$active_enter"
  restarted_units+=("$unit")
  restarted_pids+=("$new_pid")
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
  # A missing target is allowed only when its canonical service root already
  # exists. That is the real guard: it catches a wrong runtime root -- the
  # failure that shipped a manifest pointing at /var/lib/gsp/gsp-multica, a
  # tree absent on gsp -- while letting a genuinely new file be created. The
  # per-file allowlist this replaces had to be edited for every added file and
  # silently encoded the old layout.
  new_targets[$index]=0
  relative_target="${targets[$index]#"$runtime_root"/}"
  service_root="$runtime_root/${relative_target%%/*}"
  [[ -d "$service_root" ]] && new_targets[$index]=1
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

declare -A changed_index_set=()
declare -a restart_units=()
declare -A restart_unit_seen=()
for index in "${!sources[@]}"; do
  selected "$index" || continue
  if ! unit_list="$(service_units_for_target "${targets[$index]}")"; then
    printf 'Unmapped manifest runtime target: %s\n' "${targets[$index]}" >&2
    invalid=1
    continue
  fi
  if [[ ! -f "${targets[$index]}" ]] || ! cmp -s -- "${sources[$index]}" "${targets[$index]}"; then
    changed_index_set[$index]=1
    while IFS= read -r unit; do
      [[ -n "${restart_unit_seen[$unit]-}" ]] && continue
      restart_unit_seen[$unit]=1
      restart_units+=("$unit")
    done <<< "$unit_list"
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
    if [[ ! -d "$(dirname -- "$target_file")" ]]; then
      printf 'Would create target directory %s\n' "$(dirname -- "$target_file")"
    fi
    printf 'Would back up %s to %s\n' "$target_file" "$backup_file"
  else
    target_parent="$(dirname -- "$target_file")"
    if [[ ! -d "$target_parent" ]]; then
      mkdir -p -- "$target_parent"
      printf 'Created target directory %s\n' "$target_parent"
    fi
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
if [[ "$mode" == dry-run ]]; then
  if (( ! restart_enabled )) && (( ${#restart_units[@]} > 0 )); then
    printf 'Restarts disabled (--no-restart).\n'
  elif (( ${#restart_units[@]} == 0 )); then
    printf 'No processes would be restarted.\n'
  else
    for unit in "${restart_units[@]}"; do
      printf 'Would restart %s\n' "$unit"
    done
  fi
fi

restart_failed=0
if [[ "$mode" == apply ]] && (( restart_enabled )); then
  for unit in "${restart_units[@]}"; do
    restart_unit "$unit" || restart_failed=1
  done
  (( restart_failed == 0 )) || exit 1
elif [[ "$mode" == apply ]] && (( ${#restart_units[@]} > 0 )); then
  printf 'Restarts disabled (--no-restart).\n'
fi

if [[ "$mode" == apply ]]; then
  receipt_dir="$runtime_root/gsp-multica/deploy-receipts"
  mkdir -p -- "$receipt_dir"
  source_sha="$(git -C "$root_dir/../.." rev-parse HEAD)"
  manifest_sha256="$(sha256sum "${sources[@]}" | sha256sum | awk '{print $1}')"
  receipt="$receipt_dir/belt-${timestamp}.json"
  restart_json=""
  for index in "${!restarted_units[@]}"; do
    [[ -z "$restart_json" ]] || restart_json+=','
    restart_json+="{\"unit\":\"${restarted_units[$index]}\",\"pid\":${restarted_pids[$index]}}"
  done
  printf '{"repo":"timrecursify/multica","source_sha":"%s","manifest_sha256":"%s","credential_keys":["DATABASE_URL","RELAY_AGENT_SECRET","RELAY_OPERATOR_SECRET","MULTICA_WORKSPACE_ID"],"restarted_units":[%s]}\n' \
    "$source_sha" "$manifest_sha256" "$restart_json" > "$receipt"
  printf 'Receipt: %s\n' "$receipt"
fi
if [[ "$mode" == apply && ${#restarted_units[@]} -eq 0 && $restart_enabled -eq 1 ]]; then
  printf 'No processes were restarted.\n'
fi
if [[ "$mode" == apply ]]; then
  printf 'Rollback receipt: %s --rollback %s' "$0" "$timestamp"
  [[ -n "$only_target" ]] && printf ' --only %s' "$only_target"
  printf '\n'
fi
