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

deployment_fence_close() {
  deployment_psql -f "$root_dir/deployment-lock.sql" >/dev/null
  deployment_psql -v invocation="$BELT_DEPLOY_INVOCATION_ID" -v pid="$$" <<'SQL' >/dev/null
UPDATE belt_deployment_control
SET admission_held = true,
    invocation_id = :'invocation',
    controller_pid = :'pid'::bigint,
    held_at = clock_timestamp(),
    released_at = NULL
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
  'callbacks=' || (SELECT count(*) FROM relay_run_log WHERE status = 'pending'))
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
      printf 'Drain timed out after %ss; deployment aborted without restart; admission fence remains closed\n' "$timeout_seconds" >&2
      return 1
    fi
    sleep "${BELT_DEPLOY_DRAIN_POLL_SECONDS:-1}"
  done
}
