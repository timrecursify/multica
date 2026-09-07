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
metadata="$release_dir/.gsp-belt-release.json"
[[ -r "$metadata" ]] || { echo "status: release metadata missing: $metadata" >&2; exit 1; }
commit_sha="$(python3 -c "import json; print(json.load(open('$metadata'))['commit_sha'])")"
[[ "$commit_sha" =~ ^[0-9a-f]{40}$ ]] || { echo "status: invalid release commit SHA" >&2; exit 1; }

apps="gsp-multica-bridge,gsp-multica-worker,multica-cicd-worker,multica-archiver,multica-relay-advance"
snapshot="$(mktemp "${TMPDIR:-/tmp}/gsp-belt-status.XXXXXX")"
trap 'rm -f "$snapshot"' EXIT
"$PM2" jlist > "$snapshot"

echo "release commit = $commit_sha"
fail=0
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
[[ $fail -eq 0 ]] || { echo "status: one or more apps are not online in the selected immutable release" >&2; exit 1; }
echo "status: all five apps resolve to release commit $commit_sha"
