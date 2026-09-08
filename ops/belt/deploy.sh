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
source_sha=""
if [[ -n "$source_commit" ]]; then
  actual_commit="$(git -C "$root_dir/../.." rev-parse HEAD 2>/dev/null || true)"
  [[ "$actual_commit" == "$source_commit" ]] || { printf 'Source commit mismatch: checkout=%s requested=%s\n' "$actual_commit" "$source_commit" >&2; exit 2; }
  source_sha="$actual_commit"
fi

if [[ "$mode" == rollback && ! "$rollback_timestamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
  printf 'Invalid rollback timestamp: %s\n' "$rollback_timestamp" >&2
  exit 2
fi

# A bare --apply would rewrite every managed target at once. Runtime and tracked
# tree have drifted independently, so an unscoped apply must be asked for by name.
if [[ "$mode" == apply && -z "$only_target" && $allow_full -eq 0 ]]; then
  printf 'Refusing an unscoped --apply: pass --only TARGET, or --all to deploy every managed file.\n' >&2
  exit 2
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
runtime_root="${BELT_DEPLOY_RUNTIME_ROOT:-/opt/gsp/multica-workers}"
receipt_root="${MULTICA_RECEIPT_ROOT:-/var/lib/gsp-multica/runtime/receipts}"
receipt_repository="timrecursify/multica"
receipt_target="gsp-belt"
receipt_owner="ops/belt/deploy.sh"
receipt_probe="systemd-active-mainpid-runtime-parity-v1"
deployment_fence_closed=0
deployment_drain_timed_out=0
deployment_cleanup_running=0

. "$root_dir/deployment-drain.sh"

# Manifest lives in one place; see belt-manifest.sh.
. "$root_dir/belt-manifest.sh"

declare -a backups=()
declare -a touched=()
declare -a absence_markers=()
restore_on_failure() {
  local rc="${1:-$?}" index
  (( deployment_cleanup_running == 0 )) || return "$rc"
  deployment_cleanup_running=1
  trap - ERR EXIT INT TERM
  if (( rc != 0 )) && [[ "$mode" == apply && ${#touched[@]} -gt 0 ]]; then
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
  if (( deployment_fence_closed == 1 && deployment_drain_timed_out == 0 )); then
    deployment_fence_open || printf 'CRITICAL: failed to reopen admission fence during cleanup\n' >&2
  fi
  exit "$rc"
}
trap 'restore_on_failure $?' ERR EXIT
trap 'restore_on_failure 130' INT
trap 'restore_on_failure 143' TERM

if [[ "$only_target" == belt-unit-guard ]]; then
  [[ "$mode" != rollback ]] || { printf 'belt-unit-guard rollback is not supported\n' >&2; exit 2; }
  if [[ "$mode" == apply ]]; then
    deployment_lock_acquire
    deployment_fence_close
    deployment_wait_for_drain
  fi
  "$root_dir/../gsp-belt/scripts/deploy-belt-unit-guard.sh" "$mode" "$source_commit"
  [[ "$mode" != apply ]] || deployment_fence_open
  exit
fi

selected() {
  local name="${sources[$1]##*/}"
  [[ -z "$only_target" || "$name" == "$only_target" || "${name%.cjs}" == "$only_target" ]]
}

# Resolve units from each manifest target's runtime service root. The worker
# root is shared by the GSP and PPP worker units; all other roots are one-to-one.
service_units_for_target() {
  local target="$1" relative service_root
  if [[ "$target" == "$doctrine_root/"* ]]; then
    printf '%s\n' gsp-multica-worker gsp-multica-worker-ppp
    return
  fi
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

process_entrypoint_for_unit() {
  case "$1" in
    gsp-multica-bridge) printf '%s\n' "$runtime_root/gsp-multica-bridge/multica-bridge.cjs" ;;
    multica-relay-advance) printf '%s\n' "$runtime_root/multica-relay-advance/app/parity/multica-relay-advance-launcher.cjs" ;;
    multica-cicd-worker) printf '%s\n' "$runtime_root/multica-cicd-worker/multica-cicd-worker.cjs" ;;
    multica-archiver) printf '%s\n' "$runtime_root/multica-archiver/multica-archiver.cjs" ;;
    gsp-multica-worker|gsp-multica-worker-ppp) printf '%s\n' "$runtime_root/gsp-multica-worker/multica-daemon-wrapper.sh" ;;
    *) return 1 ;;
  esac
}

process_reports_entrypoint() {
  local unit="$1" pid="$2" expected arg proc_root
  local -a argv=()
  proc_root="${BELT_DEPLOY_PROC_ROOT:-/proc}"
  expected="$(process_entrypoint_for_unit "$unit")" || return 1
  [[ -r "$proc_root/$pid/cmdline" ]] || return 1
  mapfile -d '' -t argv < "$proc_root/$pid/cmdline"
  for arg in "${argv[@]}"; do
    [[ "$arg" == "$expected" ]] && return 0
  done
  return 1
}

health_probe_unit() {
  local unit="$1" expected_pid="$2" state_output key value target_unit index
  local main_pid="" active_state="" substate="" belongs
  if ! state_output="$(systemctl show -p MainPID -p ActiveState -p SubState "$unit")"; then
    printf 'Health probe %s failed: %s systemctl show failed\n' "$receipt_probe" "$unit" >&2
    return 1
  fi
  while IFS='=' read -r key value; do
    case "$key" in
      MainPID) main_pid="$value" ;;
      ActiveState) active_state="$value" ;;
      SubState) substate="$value" ;;
    esac
  done <<< "$state_output"
  if [[ "$main_pid" != "$expected_pid" || "$active_state" != active || "$substate" != running ]]; then
    printf 'Health probe %s failed: %s expected_pid=%s main_pid=%s active=%s substate=%s\n' \
      "$receipt_probe" "$unit" "$expected_pid" "${main_pid:-unknown}" "${active_state:-unknown}" "${substate:-unknown}" >&2
    return 1
  fi
  if ! process_reports_entrypoint "$unit" "$main_pid"; then
    printf 'Health probe %s failed: %s pid=%s did not report the deployed entrypoint\n' "$receipt_probe" "$unit" "$main_pid" >&2
    return 1
  fi
  for index in "${!changed_index_set[@]}"; do
    belongs=0
    while IFS= read -r target_unit; do
      [[ "$target_unit" == "$unit" ]] && belongs=1
    done < <(service_units_for_target "${targets[$index]}")
    (( belongs )) || continue
    cmp -s -- "${sources[$index]}" "${targets[$index]}" || {
      printf 'Health probe %s failed: %s runtime parity mismatch: %s\n' "$receipt_probe" "$unit" "${targets[$index]}" >&2
      return 1
    }
  done
  printf 'Health probe %s passed: %s pid=%s\n' "$receipt_probe" "$unit" "$main_pid"
}

write_activation_receipt() {
  local source_sha="$1" activated_at="$2" checked_at="$3"
  local receipt_dir receipt temporary release
  receipt_dir="$receipt_root/$receipt_repository/$receipt_target"
  receipt="$receipt_dir/$source_sha.json"
  release="git:$receipt_repository@$source_sha"
  mkdir -p -- "$receipt_dir"
  temporary="$(mktemp "$receipt_dir/.$source_sha.XXXXXX")"
  printf '{"schema_version":1,"repository":"%s","target":"%s","deployment_owner":"%s","source_sha":"%s","activation":{"status":"activated","activated_at":"%s","process_sha":"%s","release":"%s"},"health":{"status":"ok","checked_at":"%s","probe":"%s"}}\n' \
    "$receipt_repository" "$receipt_target" "$receipt_owner" "$source_sha" "$activated_at" "$source_sha" "$release" "$checked_at" "$receipt_probe" > "$temporary"
  chmod 0644 -- "$temporary"
  mv -f -- "$temporary" "$receipt"
  printf 'Receipt: %s\n' "$receipt"
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
  # A missing target is allowed only when its canonical runtime or doctrine
  # root already exists. That is the real guard: it catches a wrong root -- the
  # failure that shipped a manifest pointing at /var/lib/gsp/gsp-multica, a
  # tree absent on gsp -- while letting a genuinely new file be created. The
  # per-file allowlist this replaces had to be edited for every added file and
  # silently encoded the old layout.
  new_targets[$index]=0
  if [[ "${targets[$index]}" == "$doctrine_root/"* ]]; then
    service_root="$doctrine_root"
  else
    relative_target="${targets[$index]#"$runtime_root"/}"
    service_root="$runtime_root/${relative_target%%/*}"
  fi
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

if [[ "$mode" == apply && -z "$source_sha" ]]; then
  source_sha="$(git -C "$root_dir/../.." rev-parse HEAD 2>/dev/null || true)"
  [[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || { printf 'Unable to resolve checkout source commit\n' >&2; exit 2; }
fi

if [[ "$mode" == rollback ]]; then
  deployment_lock_acquire
  deployment_fence_close
  deployment_wait_for_drain
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
  declare -A rollback_unit_seen=()
  for index in "${!targets[@]}"; do
    selected "$index" || continue
    while IFS= read -r unit; do
      [[ -n "${rollback_unit_seen[$unit]-}" ]] && continue
      rollback_unit_seen[$unit]=1
      restart_unit "$unit"
    done < <(service_units_for_target "${targets[$index]}")
  done
  deployment_fence_open
  printf 'Rollback complete for %s.\n' "$rollback_timestamp"
  exit 0
fi

if [[ "$mode" == apply ]]; then
  deployment_lock_acquire
  deployment_fence_close
  deployment_wait_for_drain
fi

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
  if [[ "$target_file" == "$doctrine_root/"* ]]; then
    chgrp --reference="$doctrine_root" -- "$target_file"
    case "$target_file" in
      *.py) chmod 0750 -- "$target_file" ;;
      *) chmod 0640 -- "$target_file" ;;
    esac
  fi
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
activation_time=""
health_check_time=""
if [[ "$mode" == apply ]] && (( restart_enabled )); then
  for unit in "${restart_units[@]}"; do
    restart_unit "$unit" || restart_failed=1
  done
  (( restart_failed == 0 )) || exit 1
  if (( ${#restarted_units[@]} > 0 )); then
    activation_time="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    for index in "${!restarted_units[@]}"; do
      health_probe_unit "${restarted_units[$index]}" "${restarted_pids[$index]}" || restart_failed=1
    done
    (( restart_failed == 0 )) || exit 1
    health_check_time="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  fi
elif [[ "$mode" == apply ]] && (( ${#restart_units[@]} > 0 )); then
  printf 'Restarts disabled (--no-restart).\n'
fi

if [[ "$mode" == apply && ${#restarted_units[@]} -gt 0 ]]; then
  write_activation_receipt "$source_sha" "$activation_time" "$health_check_time"
fi
if [[ "$mode" == apply && ${#restarted_units[@]} -eq 0 && $restart_enabled -eq 1 ]]; then
  printf 'No processes were restarted.\n'
fi
if [[ "$mode" == apply ]]; then
  printf 'Rollback receipt: %s --rollback %s' "$0" "$timestamp"
  [[ -n "$only_target" ]] && printf ' --only %s' "$only_target"
  printf '\n'
  deployment_fence_open
fi
