#!/usr/bin/env bash
set -euo pipefail
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf -- "$fixture"' EXIT
release="$fixture/release"
mkdir -p "$release/ops/belt" "$fixture/bin"
printf '%s\n' '{"commit_sha":"0123456789012345678901234567890123456789"}' >"$release/.gsp-belt-release.json"
cat >"$fixture/bin/pm2" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == jlist ]]; then
  python3 - <<'PY'
import json
apps = 'gsp-multica-bridge gsp-multica-worker multica-cicd-worker multica-archiver multica-relay-advance'.split()
import os
print(json.dumps([{'name': n, 'pm2_env': {'pm_exec_path': os.environ['STATUS_RELEASE']+'/ops/belt/app.js', 'status': 'online', 'unstable_restarts': 2, 'restart_time': 1, 'pm_err_log_path': '/var/log/'+n+'.err'}} for n in apps]))
PY
else
  exit 0
fi
EOF
chmod +x "$fixture/bin/pm2"
state="$fixture/burst.json"
STATUS_RELEASE="$release" PATH="$fixture/bin:$PATH" bash "$root_dir/belt-status.sh" --release "$release" --worker-restart-burst-state "$state" >"$fixture/out"
grep -q 'release commit = 0123456789012345678901234567890123456789' "$fixture/out"
grep -q "gsp-multica-worker -> $release/ops/belt/app.js (status=online unstable_restarts=2" "$fixture/out"
grep -q 'restart_burst app=gsp-multica-worker count=2' "$fixture/out"
grep -q 'status=healthy pm2_error_log=/var/log/gsp-multica-worker.err' "$fixture/out"
grep -q 'status: all five apps resolve to release commit' "$fixture/out"
printf '%s\n' 'belt status reporting regression passed'

# Missing worker restart diagnostics must fail closed and identify the PM2 log.
sed -i "s/'restart_time': 1,/'restart_time': ('' if os.environ.get('STATUS_DIAGNOSTIC_FAILURE') else 1),/" "$fixture/bin/pm2"
if STATUS_RELEASE="$release" STATUS_DIAGNOSTIC_FAILURE=1 PATH="$fixture/bin:$PATH" bash "$root_dir/belt-status.sh" --release "$release" --worker-restart-burst-state "$fixture/diag.json" >"$fixture/diag.out" 2>"$fixture/diag.err"; then
  echo 'diagnostic failure unexpectedly passed' >&2
  exit 1
fi
grep -q 'status=diagnostic_failure' "$fixture/diag.err"
grep -q 'pm2_error_log=/var/log/gsp-multica-worker.err' "$fixture/diag.err"
printf '%s\n' 'belt status diagnostic fail-closed regression passed'
