#!/bin/bash
# Report the immutable release SHA and resolved PM2 path for every GSP belt app.
# This is read-only and intentionally prints no environment values.
set -euo pipefail

PM2="${PM2:-pm2}"
release_dir=""
baseline=""
worker_baseline=""
relay_baseline=""
burst_threshold="${GSP_WORKER_RESTART_BURST_THRESHOLD:-3}"
burst_window="${GSP_WORKER_RESTART_BURST_WINDOW_SECONDS:-300}"
burst_state="${GSP_WORKER_RESTART_BURST_STATE:-${TMPDIR:-/tmp}/gsp-multica-worker-restart-burst.json}"
hold_file="${MULTICA_AI_HOLD_FILE:-/var/lib/gsp/.local/state/multica-ai-hold}"
release_file="${MULTICA_OPERATOR_RELEASE_FILE:-/var/lib/gsp/.local/state/multica-operator-release}"
approval_file="${MULTICA_SUPERVISOR_APPROVAL_FILE:-/var/lib/gsp/.local/state/multica-supervisor-approval}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --release) release_dir="$2"; shift 2;;
    --baseline-unstable-restarts) baseline="$2"; shift 2;;
    --baseline-worker-unstable-restarts) worker_baseline="$2"; shift 2;;
    --baseline-relay-unstable-restarts) relay_baseline="$2"; shift 2;;
    --worker-restart-burst-threshold) burst_threshold="$2"; shift 2;;
    --worker-restart-burst-window-seconds) burst_window="$2"; shift 2;;
    --worker-restart-burst-state) burst_state="$2"; shift 2;;
    -h|--help) echo "usage: belt-status.sh --release DIR [--baseline-unstable-restarts N] [--baseline-worker-unstable-restarts N] [--baseline-relay-unstable-restarts N] [--worker-restart-burst-threshold N] [--worker-restart-burst-window-seconds N] [--worker-restart-burst-state FILE]"; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
[[ -n "$release_dir" ]] || { echo "usage: belt-status.sh --release DIR" >&2; exit 2; }
[[ "$burst_threshold" =~ ^[0-9]+$ && "$burst_window" =~ ^[0-9]+$ ]] || { echo "status: invalid restart burst configuration" >&2; exit 2; }
fail=0

# Workspace-scoped completion liveness. Deployed runs always use the
# authoritative adapter; BELT_COMPLETION_LIVENESS_INPUT is retained for tests.
if [[ -n "${BELT_COMPLETION_STALL_WINDOW:-}" ]]; then
  if [[ -z "${BELT_COMPLETION_LIVENESS_INPUT:-}" ]]; then
    # The adapter consumes the authoritative source command.  In deployed
    # runs this is supplied by the service environment; mirror it explicitly
    # so the boundary cannot fail solely due to a variable-name mismatch.
    if [[ -n "${BELT_COMPLETION_AUTHORITATIVE_METRICS_SOURCE_COMMAND:-}" ]]; then
      export BELT_COMPLETION_AUTHORITATIVE_METRICS_COMMAND="$BELT_COMPLETION_AUTHORITATIVE_METRICS_SOURCE_COMMAND"
      export BELT_COMPLETION_METRICS_COMMAND="node $(dirname "$0")/belt-completion-metrics.cjs"
    fi
  fi
  if ! liveness_result=$(node "$(dirname "$0")/belt-completion-liveness.cjs"); then
    echo "completion_liveness $liveness_result" >&2
    fail=1
  else
    echo "completion_liveness $liveness_result"
  fi
fi
metadata="$release_dir/.gsp-belt-release.json"
[[ -r "$metadata" ]] || { echo "status: release metadata missing: $metadata" >&2; exit 1; }
commit_sha="$(python3 -c "import json; print(json.load(open('$metadata'))['commit_sha'])")"
[[ "$commit_sha" =~ ^[0-9a-f]{40}$ ]] || { echo "status: invalid release commit SHA" >&2; exit 1; }

capacity_query="SELECT workspace_slug, stage_name, capacity_budget, available_capacity, ready_count, waiting_count, running_count FROM public.relay_stage_capacity_status ORDER BY workspace_slug, stage_name;"
echo "stage capacity: workspace|stage|budget|available|ready|waiting|running"
if ! sudo -n /bin/bash -c "docker exec gsp-multica-v2-postgres-1 psql -U gsp_multica -d gsp_multica -At -c \"$capacity_query\""; then
  echo "status: stage capacity view unavailable" >&2
  fail=1
fi

apps="gsp-multica-bridge,gsp-multica-worker,multica-cicd-worker,multica-archiver,multica-relay-advance"
snapshot="$(mktemp "${TMPDIR:-/tmp}/gsp-belt-status.XXXXXX")"
trap 'rm -f "$snapshot"' EXIT
"$PM2" jlist > "$snapshot"

echo "release commit = $commit_sha"
if [[ -f "$hold_file" ]]; then remediation_state=held
elif [[ -f "$release_file" && -f "$approval_file" ]]; then remediation_state=released
else remediation_state=unreleased
fi
echo "worker remediation release_state = $remediation_state (hold=$hold_file release=$release_file approval=$approval_file)"
IFS=',' read -r -a app_arr <<< "$apps"
for app in "${app_arr[@]}"; do
  read -r path status unstable restart_time err_path exit_code exit_signal < <(python3 - "$snapshot" "$app" <<'PY'
import json, sys
for item in json.load(open(sys.argv[1])):
    if item.get('name') == sys.argv[2]:
        env = item.get('pm2_env', {})
        print(env.get('pm_exec_path', ''), env.get('status', ''), env.get('unstable_restarts', ''), env.get('restart_time', ''), env.get('pm_err_log_path', ''), env.get('exit_code', ''), env.get('exit_signal', ''))
        break
PY
)
  echo "$app -> $path (status=$status unstable_restarts=${unstable:-unknown} restart_time=${restart_time:-unknown})"
  if [[ "$app" == gsp-multica-bridge && -n "$baseline" && "$unstable" =~ ^[0-9]+$ && "$unstable" -gt "$baseline" ]]; then
    echo "status: bridge unstable_restarts increased from $baseline to $unstable (exit_code=${exit_code:-unknown} exit_signal=${exit_signal:-unknown} log=${err_path:-unknown})" >&2
    fail=1
  fi
  if [[ "$app" == gsp-multica-worker && -n "$worker_baseline" ]]; then
    if [[ "$worker_baseline" =~ ^[0-9]+$ && "$unstable" =~ ^[0-9]+$ ]]; then
      if [[ "$unstable" -gt "$worker_baseline" ]]; then
        echo "status: worker unstable_restarts increased from $worker_baseline to $unstable (exit_code=${exit_code:-unknown} exit_signal=${exit_signal:-unknown} log=${err_path:-unknown})" >&2
        fail=1
      fi
    else
      echo "status: worker unstable_restarts unknown (expected baseline $worker_baseline; exit_code=${exit_code:-unknown} exit_signal=${exit_signal:-unknown} log=${err_path:-unknown})" >&2
      fail=1
    fi
  fi
  if [[ "$app" == gsp-multica-worker ]]; then
    burst_count=""
    now="$(date +%s)"
    if [[ ! "$unstable" =~ ^[0-9]+$ || ! "$restart_time" =~ ^[0-9]+$ ]]; then
      echo "restart_burst app=gsp-multica-worker count=unknown window_seconds=$burst_window threshold=$burst_threshold status=diagnostic_failure pm2_error_log=${err_path:-unknown}" >&2
      fail=1
    else
      previous_count=0; previous_at="$now"
      if [[ -r "$burst_state" ]]; then
        read -r previous_count previous_at < <(python3 - "$burst_state" <<'PY'
import json, sys
try:
 d=json.load(open(sys.argv[1])); print(d.get('count',0), d.get('observed_at',0))
except Exception: print(0, 0)
PY
)
      fi
      if [[ "$previous_count" =~ ^[0-9]+$ && "$previous_at" =~ ^[0-9]+$ && $((now - previous_at)) -le "$burst_window" && "$unstable" -ge "$previous_count" ]]; then
        burst_count=$((unstable - previous_count))
      else
        burst_count=0
      fi
      mkdir -p "$(dirname "$burst_state")"
      python3 - "$burst_state" "$unstable" "$now" <<'PY'
import json, os, sys
tmp=sys.argv[1]+'.tmp'; json.dump({'count':int(sys.argv[2]),'observed_at':int(sys.argv[3])}, open(tmp,'w')); os.replace(tmp,sys.argv[1])
PY
      burst_status=healthy
      if (( burst_count > burst_threshold )); then
        burst_status=unhealthy; fail=1
      fi
      echo "restart_burst app=gsp-multica-worker count=$burst_count window_seconds=$burst_window threshold=$burst_threshold status=$burst_status pm2_error_log=${err_path:-unknown}"
      (( burst_count > burst_threshold )) && echo "restart_burst app=gsp-multica-worker count=$burst_count window_seconds=$burst_window threshold=$burst_threshold status=unhealthy pm2_error_log=${err_path:-unknown}" >&2
    fi
  fi
  if [[ "$app" == multica-relay-advance && -n "$relay_baseline" && "$unstable" =~ ^[0-9]+$ && "$unstable" -gt "$relay_baseline" ]]; then
    echo "status: relay unstable_restarts increased from $relay_baseline to $unstable (exit_code=${exit_code:-unknown} exit_signal=${exit_signal:-unknown} log=${err_path:-unknown})" >&2
    fail=1
  fi
  [[ "$path" == "$release_dir/ops/belt/"* && "$status" == "online" ]] || fail=1
done

print_unattended_lifecycle_metrics() {
  local activated_sha="$1" query output
  read -r -d '' query <<'SQL' || true
WITH task_stage AS (
  SELECT COALESCE(rrl.to_stage,t.context->>'to_stage',t.context->>'pool_stage') AS stage,t.*
  FROM agent_task_queue t LEFT JOIN relay_run_log rrl ON rrl.task_id=t.id
), entries AS (
  SELECT to_stage AS stage,max(created_at) AS entry_at FROM relay_run_log WHERE to_stage<>'Registered' GROUP BY to_stage
  UNION ALL SELECT 'Registered',max(created_at) FROM issue
)
SELECT 'lifecycle_stage stage='||quote_literal(e.stage)||' entry_at='||COALESCE(e.entry_at::text,'none')||
  ' eligible_at='||COALESCE(max(t.created_at)::text,'none')||' wait_at='||COALESCE(max(t.updated_at) FILTER (WHERE t.status LIKE 'waiting%')::text,'none')||
  ' start_at='||COALESCE(max(t.started_at)::text,'none')||' finish_at='||COALESCE(max(t.completed_at)::text,'none')||
  ' blocker_owner='||COALESCE(string_agg(DISTINCT o.blocked_on,','),'none')||' queue_age_seconds='||
  COALESCE(max(extract(epoch FROM (now()-t.created_at))) FILTER (WHERE t.status IN ('queued','dispatched','waiting_local_directory','deferred'))::bigint::text,'0')
FROM entries e LEFT JOIN task_stage t ON t.stage=e.stage LEFT JOIN issue_stage_outcome o ON o.task_id=t.id
GROUP BY e.stage,e.entry_at ORDER BY array_position(ARRAY['Registered','Spec','Queue','In Progress','In Review','CI/CD & Deploy','Done','Archived'],e.stage);
SELECT 'lifecycle_outcome outcome='||outcome||' unique_issues='||count(DISTINCT issue_id) FROM issue_stage_outcome GROUP BY outcome ORDER BY outcome;
SELECT 'lifecycle_flow pr_inflow='||(SELECT count(DISTINCT issue_id) FROM issue_pull_request)||
  ' merge_outflow='||(SELECT count(DISTINCT ipr.issue_id) FROM issue_pull_request ipr JOIN github_pull_request pr ON pr.id=ipr.pull_request_id WHERE pr.merged_at IS NOT NULL)||
  ' shipped='||(SELECT count(DISTINCT a.issue_id) FROM activity_log a JOIN issue i ON i.id=a.issue_id WHERE a.action='relay_transition' AND a.details->>'to_stage'='Done' AND i.status IN ('Done','Archived') AND (a.details->>'from_stage'='CI/CD & Deploy' OR a.details#>>'{evidence,workProductEvidence}' ~* '\mNO-SHA\M'))||
  ' cancelled='||(SELECT count(*) FROM issue WHERE status='Cancelled')||' approval_waits='||(SELECT count(*) FROM issue WHERE status='Human Review');
WITH latest_merge AS (
  SELECT COALESCE(details#>>'{evidence,mergeDeployReceipt,source_sha}',details#>>'{evidence,mergeDeployReceipt,sha}') AS merged_sha,created_at
  FROM activity_log WHERE action='relay_transition' AND details->>'from_stage'='CI/CD & Deploy' AND details->>'to_stage'='Done'
  ORDER BY created_at DESC LIMIT 1
)
SELECT 'activated_vs_merged_sha activated_sha='||current_setting('belt.activated_sha')||' merged_sha='||COALESCE(merged_sha,'none')||
  ' matches='||COALESCE((merged_sha=current_setting('belt.activated_sha'))::text,'false')||' lag_seconds='||
  COALESCE((CASE WHEN merged_sha IS NULL THEN NULL WHEN merged_sha=current_setting('belt.activated_sha') THEN 0 ELSE extract(epoch FROM (now()-created_at)) END)::bigint::text,'unknown') FROM latest_merge;
SQL
  if ! output="$(sudo -n /bin/bash -c 'docker exec gsp-multica-v2-postgres-1 psql -U gsp_multica -d gsp_multica -v ON_ERROR_STOP=1 -qAt -c "SET belt.activated_sha TO '\''$1'\''; $2"' _ "$activated_sha" "$query" 2>&1)"; then
    echo "lifecycle_metrics status=unavailable" >&2
    return 0
  fi
  printf '%s\n' "$output"
}

[[ $fail -eq 0 ]] || { echo "status: one or more apps are not online in the selected immutable release" >&2; exit 1; }
echo "status: all five apps resolve to release commit $commit_sha"
print_unattended_lifecycle_metrics "$commit_sha"
