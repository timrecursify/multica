#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf -- "$fixture"' EXIT
release="$fixture/release"
mkdir -p "$release/ops/belt" "$fixture/bin"
printf '%s\n' '{"commit_sha":"0123456789abcdef0123456789abcdef01234567"}' >"$release/.gsp-belt-release.json"
for app in gsp-multica-bridge gsp-multica-worker multica-cicd-worker multica-archiver multica-relay-advance; do
  mkdir -p "$release/ops/belt"
done
cat >"$fixture/bin/pm2" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == jlist ]]; then
  cat "$PM2_FIXTURE"
else
  echo "unexpected pm2 command" >&2
  exit 2
fi
EOF
chmod +x "$fixture/bin/pm2"
cat >"$fixture/pm2.json" <<EOF
[
$(printf '%s\n' '  {"name":"gsp-multica-bridge","pm2_env":{"pm_exec_path":"'"$release"'/ops/belt/bridge","status":"online","unstable_restarts":0,"restart_time":1,"pm_err_log_path":"/logs/bridge.err"}},')
$(printf '%s\n' '  {"name":"gsp-multica-worker","pm2_env":{"pm_exec_path":"'"$release"'/ops/belt/worker","status":"online","unstable_restarts":1,"restart_time":1,"pm_err_log_path":"/logs/worker.err"}},')
$(printf '%s\n' '  {"name":"multica-cicd-worker","pm2_env":{"pm_exec_path":"'"$release"'/ops/belt/cicd","status":"online","unstable_restarts":0,"restart_time":1,"pm_err_log_path":"/logs/cicd.err"}},')
$(printf '%s\n' '  {"name":"multica-archiver","pm2_env":{"pm_exec_path":"'"$release"'/ops/belt/archive","status":"online","unstable_restarts":0,"restart_time":1,"pm_err_log_path":"/logs/archive.err"}},')
  {"name":"multica-relay-advance","pm2_env":{"pm_exec_path":"$release/ops/belt/relay","status":"online","unstable_restarts":0,"restart_time":1,"pm_err_log_path":"/logs/relay.err"}}
]
EOF
output="$(PATH="$fixture/bin:$PATH" PM2_FIXTURE="$fixture/pm2.json" "$root_dir/belt-status.sh" --release "$release" --worker-restart-burst-state "$fixture/state.json")"
grep -q 'release commit = 0123456789abcdef0123456789abcdef01234567' <<<"$output"
grep -q 'gsp-multica-worker -> .*status=online' <<<"$output"
grep -q 'restart_burst app=gsp-multica-worker .*status=healthy pm2_error_log=/logs/worker.err' <<<"$output"

python3 - "$fixture/pm2.json" <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))
for item in p:
    if item['name'] == 'gsp-multica-worker':
        item['pm2_env']['unstable_restarts'] = 8
json.dump(p, open(sys.argv[1], 'w'))
PY
if PATH="$fixture/bin:$PATH" PM2_FIXTURE="$fixture/pm2.json" "$root_dir/belt-status.sh" --release "$release" --worker-restart-burst-threshold 3 --worker-restart-burst-state "$fixture/state.json" >/dev/null 2>"$fixture/error"; then
  echo 'restart burst unexpectedly accepted' >&2
  exit 1
fi
grep -q 'restart_burst app=gsp-multica-worker .*status=unhealthy pm2_error_log=/logs/worker.err' "$fixture/error"
echo 'belt status tests: PASS'
