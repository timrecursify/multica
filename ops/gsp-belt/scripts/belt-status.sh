#!/bin/bash
# Report the immutable release SHA and resolved PM2 path for every GSP belt app.
# This is read-only and intentionally prints no environment values.
set -euo pipefail

PM2="${PM2:-pm2}"
release_dir=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --release) release_dir="$2"; shift 2;;
    -h|--help) echo "usage: belt-status.sh --release DIR"; exit 0;;
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
  read -r path status < <(python3 - "$snapshot" "$app" <<'PY'
import json, sys
for item in json.load(open(sys.argv[1])):
    if item.get('name') == sys.argv[2]:
        env = item.get('pm2_env', {})
        print(env.get('pm_exec_path', ''), env.get('status', ''))
        break
PY
)
  echo "$app -> $path (status=$status)"
  [[ "$path" == "$release_dir/ops/gsp-belt/"* && "$status" == "online" ]] || fail=1
done
[[ $fail -eq 0 ]] || { echo "status: one or more apps are not online in the selected immutable release" >&2; exit 1; }
echo "status: all five apps resolve to release commit $commit_sha"
