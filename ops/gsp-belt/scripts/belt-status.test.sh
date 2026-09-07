#!/usr/bin/env bash
set -euo pipefail
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
fixture="$(mktemp -d)"; trap 'rm -rf -- "$fixture"' EXIT
release="$fixture/release"; mkdir -p "$release/ops/belt" "$fixture/bin"
printf '%s\n' '{"commit_sha":"0123456789abcdef0123456789abcdef01234567"}' >"$release/.gsp-belt-release.json"
cat >"$fixture/bin/pm2" <<'EOF'
#!/usr/bin/env bash
[[ "$1" == jlist ]] && cat "$PM2_FIXTURE" || exit 2
EOF
chmod +x "$fixture/bin/pm2"
cat >"$fixture/pm2.json" <<EOF
[
{"name":"gsp-multica-bridge","pm2_env":{"pm_exec_path":"$release/ops/belt/bridge","status":"online","unstable_restarts":0,"restart_time":1,"pm_err_log_path":"/logs/bridge.err"}},
{"name":"gsp-multica-worker","pm2_env":{"pm_exec_path":"$release/ops/belt/worker","status":"online","unstable_restarts":1,"restart_time":1,"pm_err_log_path":"/logs/worker.err"}},
{"name":"multica-cicd-worker","pm2_env":{"pm_exec_path":"$release/ops/belt/cicd","status":"online","unstable_restarts":0,"restart_time":1,"pm_err_log_path":"/logs/cicd.err"}},
{"name":"multica-archiver","pm2_env":{"pm_exec_path":"$release/ops/belt/archive","status":"online","unstable_restarts":0,"restart_time":1,"pm_err_log_path":"/logs/archive.err"}},
{"name":"multica-relay-advance","pm2_env":{"pm_exec_path":"$release/ops/belt/relay","status":"online","unstable_restarts":0,"restart_time":1,"pm_err_log_path":"/logs/relay.err"}}
]
EOF
output="$(PATH="$fixture/bin:$PATH" PM2_FIXTURE="$fixture/pm2.json" "$root_dir/belt-status.sh" --release "$release" --worker-restart-burst-state "$fixture/state.json")"
grep -q 'release commit = 0123456789abcdef0123456789abcdef01234567' <<<"$output"
grep -q 'gsp-multica-worker -> .*status=online' <<<"$output"
grep -q 'restart_burst app=gsp-multica-worker .*status=healthy pm2_error_log=/logs/worker.err' <<<"$output"
python3 - "$fixture/pm2.json" <<'PY'
import json, sys
p=json.load(open(sys.argv[1]))
for x in p:
  if x['name']=='gsp-multica-worker': x['pm2_env']['unstable_restarts']=8
json.dump(p, open(sys.argv[1],'w'))
PY
if PATH="$fixture/bin:$PATH" PM2_FIXTURE="$fixture/pm2.json" "$root_dir/belt-status.sh" --release "$release" --worker-restart-burst-threshold 3 --worker-restart-burst-state "$fixture/state.json" >/dev/null 2>"$fixture/error"; then exit 1; fi
grep -q 'status=unhealthy pm2_error_log=/logs/worker.err' "$fixture/error"
echo 'belt status tests: PASS'
