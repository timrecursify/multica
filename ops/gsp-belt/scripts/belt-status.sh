#!/bin/bash
# Report the immutable release SHA and resolved PM2 path for every GSP belt app.
# This is read-only and intentionally prints no environment values.
set -euo pipefail

PM2="${PM2:-pm2}"
release_dir=""
baseline=""
worker_baseline=""
relay_baseline=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --release) release_dir="$2"; shift 2;;
    --baseline-unstable-restarts) baseline="$2"; shift 2;;
    --baseline-worker-unstable-restarts) worker_baseline="$2"; shift 2;;
    --baseline-relay-unstable-restarts) relay_baseline="$2"; shift 2;;
    -h|--help) echo "usage: belt-status.sh --release DIR [--baseline-unstable-restarts N] [--baseline-worker-unstable-restarts N] [--baseline-relay-unstable-restarts N]"; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
[[ -n "$release_dir" ]] || { echo "usage: belt-status.sh --release DIR" >&2; exit 2; }
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
  if [[ "$app" == multica-relay-advance && -n "$relay_baseline" && "$unstable" =~ ^[0-9]+$ && "$unstable" -gt "$relay_baseline" ]]; then
    echo "status: relay unstable_restarts increased from $relay_baseline to $unstable (exit_code=${exit_code:-unknown} exit_signal=${exit_signal:-unknown} log=${err_path:-unknown})" >&2
    fail=1
  fi
  [[ "$path" == "$release_dir/ops/belt/"* && "$status" == "online" ]] || fail=1
done
[[ $fail -eq 0 ]] || { echo "status: one or more apps are not online in the selected immutable release" >&2; exit 1; }
echo "status: all five apps resolve to release commit $commit_sha"
