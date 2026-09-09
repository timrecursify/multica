#!/usr/bin/env bash
# Shared by apply and rollback. The database row is the durable admission
# fence; fd 8 serializes controllers from every checkout on this target.

deployment_lock_acquire() {
  BELT_DEPLOY_STATE_ROOT="${BELT_DEPLOY_STATE_ROOT:-/var/lib/gsp-multica/runtime}"
  export BELT_DEPLOY_STATE_ROOT
  mkdir -p -- "$BELT_DEPLOY_STATE_ROOT"
  exec 8>"$BELT_DEPLOY_STATE_ROOT/deployment.lock"
  flock 8
  BELT_DEPLOY_INVOCATION_ID="${timestamp}-$$"
  export BELT_DEPLOY_INVOCATION_ID
  printf 'Deployment lock acquired: invocation=%s controller_pid=%s\n' "$BELT_DEPLOY_INVOCATION_ID" "$$"
}

deployment_psql() {
  local database_url="${BELT_DEPLOY_DATABASE_URL:-${DATABASE_URL:-}}"
  [[ -n "$database_url" ]] || {
    printf 'BELT_DEPLOY_DATABASE_URL or DATABASE_URL is required for a restarting apply/rollback\n' >&2
    return 2
  }
  psql "$database_url" -X -v ON_ERROR_STOP=1 "$@"
}

deployment_process_identity() {
  local pid="$1" proc_root="${BELT_DEPLOY_CONTROLLER_PROC_ROOT:-/proc}" stat_line stat_tail boot_id start_ticks restore_glob=1
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ -r "$proc_root/$pid/stat" && -r "$proc_root/sys/kernel/random/boot_id" ]] || return 1
  IFS= read -r stat_line < "$proc_root/$pid/stat" || return 1
  stat_tail="${stat_line##*) }"
  # starttime is field 22 of /proc/PID/stat, or field 20 after pid and comm.
  [[ $- == *f* ]] && restore_glob=0
  set -f
  set -- $stat_tail
  (( restore_glob == 0 )) || set +f
  start_ticks="${20:-}"
  IFS= read -r boot_id < "$proc_root/sys/kernel/random/boot_id" || return 1
  [[ "$start_ticks" =~ ^[0-9]+$ && -n "$boot_id" ]] || return 1
  printf '%s|%s\n' "$start_ticks" "$boot_id"
}

deployment_controller_alive() {
  local pid="$1" expected_start="$2" expected_boot="$3" identity
  [[ -n "$expected_start" && -n "$expected_boot" ]] || return 1
  identity="$(deployment_process_identity "$pid")" || return 1
  [[ "$identity" == "$expected_start|$expected_boot" ]]
}

deployment_fence_alarm() {
  local stale_invocation="$1" stale_pid="$2" sk="${BELT_DEPLOY_SK:-}" out
  local alarm_user="${BELT_DEPLOY_ALARM_USER:-newadmin}" runuser_bin="${BELT_DEPLOY_RUNUSER:-/usr/sbin/runuser}"
  local alarm_home="${BELT_DEPLOY_ALARM_HOME:-/home/$alarm_user}" alarm_path="${BELT_DEPLOY_ALARM_PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
  if [[ -z "$sk" ]]; then
    sk="$(command -v sk 2>/dev/null || true)"
    [[ -n "$sk" ]] || sk=/home/newadmin/.local/bin/sk
  fi
  if [[ ! -x "$sk" ]]; then
    deployment_fence_alarm_status=failed
    printf 'CRITICAL: unable to file stale-fence P0: sk executable unavailable (resolved path: %s)\n' "${sk:-none}" >&2
    return 1
  fi
  if [[ ! -x "$runuser_bin" ]]; then
    deployment_fence_alarm_status=failed
    printf 'CRITICAL: unable to file stale-fence P0: unprivileged launcher unavailable (resolved path: %s)\n' "$runuser_bin" >&2
    return 1
  fi
  if out=$("$runuser_bin" -u "$alarm_user" -- env -i HOME="$alarm_home" PATH="$alarm_path" BELT_DEPLOY_ALARM_USER="$alarm_user" "$sk" multica create --board gsp \
    --title 'P0: belt admission fence has a dead controller' \
    --desc - 2>&1 <<EOF
Automated by ops/belt/deploy.sh on $(hostname) at $(date -Is).

The durable admission fence was held by dead controller invocation ${stale_invocation:-unknown}, pid ${stale_pid:-unknown}. A new serialized controller is taking over the hold.
EOF
  ); then
    deployment_fence_alarm_status=filed
    printf 'STALE-FENCE P0 FILED: %s\n' "$out" >&2
    return 0
  fi
  if [[ "$out" =~ (^|$'\n')[[:space:]]*code:[[:space:]]active_duplicate_issue($|$'\n') ]]; then
    deployment_fence_alarm_status=duplicate_suppressed
    printf 'STALE-FENCE P0 ALREADY ACTIVE; duplicate suppressed:\n%s\n' "$out" >&2
    return 0
  fi
  deployment_fence_alarm_status=failed
  printf 'CRITICAL: unable to file stale-fence P0 ticket:\n%s\n' "$out" >&2
  return 1
}

deployment_fence_close() {
  local current_identity current_start current_boot row held stale_invocation stale_pid stale_start stale_boot
  current_identity="$(deployment_process_identity "$$")" || {
    printf 'Unable to establish deployment controller process identity\n' >&2
    return 2
  }
  IFS='|' read -r current_start current_boot <<< "$current_identity"
  deployment_psql -f "$root_dir/deployment-lock.sql" >/dev/null
  row="$(deployment_psql -At <<'SQL'
SELECT admission_held::int, coalesce(invocation_id, ''), coalesce(controller_pid::text, ''),
       coalesce(controller_start_ticks::text, ''), coalesce(controller_boot_id, '')
FROM belt_deployment_control WHERE singleton;
SQL
  )"
  IFS='|' read -r held stale_invocation stale_pid stale_start stale_boot <<< "$row"
  if [[ "$held" == 1 ]]; then
    if deployment_controller_alive "$stale_pid" "$stale_start" "$stale_boot"; then
      printf 'Admission fence is held by live controller: invocation=%s controller_pid=%s\n' "$stale_invocation" "$stale_pid" >&2
      return 1
    fi
    if ! deployment_fence_alarm "$stale_invocation" "$stale_pid"; then
      printf 'CRITICAL: stale-fence takeover is continuing without a filed P0 alarm; receipt will record the alarm failure\n' >&2
    fi
    printf 'Taking over stale admission fence: prior_invocation=%s prior_controller_pid=%s\n' "$stale_invocation" "$stale_pid"
  fi
  deployment_psql -v invocation="$BELT_DEPLOY_INVOCATION_ID" -v pid="$$" \
    -v start_ticks="$current_start" -v boot_id="$current_boot" \
    -v takeover_invocation="${stale_invocation:-}" -v taking_over="$([[ "$held" == 1 ]] && printf true || printf false)" <<'SQL' >/dev/null
UPDATE belt_deployment_control
SET admission_held = true,
    invocation_id = :'invocation',
    controller_pid = :'pid'::bigint,
    controller_start_ticks = :'start_ticks'::bigint,
    controller_boot_id = :'boot_id',
    held_at = clock_timestamp(),
    released_at = NULL,
    takeover_of_invocation_id = CASE WHEN :'taking_over'::boolean THEN nullif(:'takeover_invocation', '') ELSE NULL END,
    takeover_at = CASE WHEN :'taking_over'::boolean THEN clock_timestamp() ELSE NULL END
WHERE singleton;
SQL
  local temporary
  temporary="$(mktemp "$BELT_DEPLOY_STATE_ROOT/.deployment-hold.XXXXXX")"
  printf 'invocation=%s\ncontroller_pid=%s\n' "$BELT_DEPLOY_INVOCATION_ID" "$$" >"$temporary"
  chmod 0640 "$temporary"
  mv -f -- "$temporary" "$BELT_DEPLOY_STATE_ROOT/deployment.hold"
  deployment_fence_closed=1
  printf 'Admission fence closed: invocation=%s controller_pid=%s\n' "$BELT_DEPLOY_INVOCATION_ID" "$$"
}

deployment_fence_open() {
  deployment_psql -v invocation="$BELT_DEPLOY_INVOCATION_ID" <<'SQL' >/dev/null
UPDATE belt_deployment_control
SET admission_held = false, released_at = clock_timestamp()
WHERE singleton AND invocation_id = :'invocation';
SQL
  rm -f -- "$BELT_DEPLOY_STATE_ROOT/deployment.hold"
  deployment_fence_closed=0
  printf 'Admission fence opened: invocation=%s\n' "$BELT_DEPLOY_INVOCATION_ID"
}

# Every relation named here must exist in server/migrations, which is what the
# Multica database is actually built from. deployment-drain-schema.test.sh
# enforces that, because a term naming a missing relation aborts the whole
# snapshot and the drain can then never confirm.
#
# There is deliberately no cicd term. `cicd_deploy_attempt` belongs to the
# superseded ops/gsp-belt noc2 tree and appears in none of the canonical
# migrations, so counting it aborted every poll. It is removed rather than
# defaulted to zero: a term that always reports zero would claim a clean drain
# while CI/CD work was live.
#
# The consequence is stated rather than hidden: the deployed CI/CD worker
# (/opt/gsp/multica-workers/multica-cicd-worker) keeps no durable in-flight
# record at all -- it writes only retry counters into issue.metadata -- so no
# query can observe a merge it has in flight. Draining does not cover that
# worker. Stop its unit before deploying if that matters.
deployment_drain_snapshot() {
  deployment_psql -At <<'SQL'
SELECT concat_ws(' ',
  'leases=' || count(*) FILTER (WHERE status IN ('dispatched','running') OR prepare_lease_expires_at IS NOT NULL),
  'children=' || count(*) FILTER (WHERE parent_task_id IS NOT NULL AND status IN ('dispatched','running')),
  -- callbacks counts only pending rows the advancer can still consume.
  --
  -- The authority is the daemon's own consumption model, stated above
  -- enqueuePassWithoutRelayRows in ops/belt/parity/multica-relay-advance-daemon.cjs:858:
  -- "findAndAdvanceTasks deliberately consumes only pending, task-correlated
  -- rows". A pending row whose task is finished, or which carries no task_id at
  -- all, will never be consumed, so a restart cannot interrupt it. It is not
  -- in-flight work and must not hold a drain open.
  --
  -- Age is deliberately NOT the axis. cleanupStalePendingRows (same file, :826)
  -- closes a pending row only when the issue has advanced past that row's
  -- to_stage; it defines no age constant, and there is none to cite elsewhere,
  -- so any hour threshold here would be invented. Do not "fix" this back to
  -- counting every pending row: measured live on 2026-09-07, that was 1588 rows
  -- of which 2 were task-live, 935 pointed at terminal tasks and 650 had no
  -- task_id, so the drain could never return and no deploy could proceed.
  'callbacks=' || (SELECT count(*) FROM relay_run_log rrl
     JOIN agent_task_queue callback_task ON callback_task.id = rrl.task_id
    WHERE rrl.status = 'pending'
      AND callback_task.status IN ('dispatched','running')))
FROM agent_task_queue;
SQL
}

deployment_wait_for_drain() {
  local timeout_seconds="${BELT_DEPLOY_DRAIN_TIMEOUT_SECONDS:-}" start now snapshot
  [[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]] || {
    printf 'BELT_DEPLOY_DRAIN_TIMEOUT_SECONDS must be set to a positive integer; no drain timeout is assumed\n' >&2
    return 2
  }
  start="$(date +%s)"
  while true; do
    snapshot="$(deployment_drain_snapshot)" || return
    printf 'Drain snapshot: %s\n' "$snapshot"
    if [[ "$snapshot" == 'leases=0 children=0 callbacks=0' ]]; then
      return 0
    fi
    now="$(date +%s)"
    if (( now - start >= timeout_seconds )); then
      deployment_drain_timed_out=1
      printf 'Drain timed out after %ss; deployment aborted without restart; admission fence remains closed\n' "$timeout_seconds" >&2
      return 1
    fi
    sleep "${BELT_DEPLOY_DRAIN_POLL_SECONDS:-1}"
  done
}
