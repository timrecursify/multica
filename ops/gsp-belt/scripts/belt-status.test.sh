#!/usr/bin/env bash
set -euo pipefail
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf -- "$fixture"' EXIT
mkdir -p "$fixture/release/ops/belt" "$fixture/bin"
printf '{"commit_sha":"%040d"}\n' 1 >"$fixture/release/.gsp-belt-release.json"
cat >"$fixture/bin/pm2" <<EOF
#!/usr/bin/env bash
[[ "\$1" == jlist ]] || exit 1
cat <<'JSON'
 [{"name":"gsp-multica-bridge","pm2_env":{"pm_exec_path":"$fixture/release/ops/belt/app","status":"online","unstable_restarts":0,"restart_time":1,"pm_err_log_path":"/logs/bridge.err"}},
 {"name":"gsp-multica-worker","pm2_env":{"pm_exec_path":"$fixture/release/ops/belt/app","status":"online","unstable_restarts":4,"restart_time":1,"pm_err_log_path":"/logs/worker.err"}},
 {"name":"multica-cicd-worker","pm2_env":{"pm_exec_path":"$fixture/release/ops/belt/app","status":"online","unstable_restarts":0,"restart_time":1,"pm_err_log_path":"/logs/cicd.err"}},
 {"name":"multica-archiver","pm2_env":{"pm_exec_path":"$fixture/release/ops/belt/app","status":"online","unstable_restarts":0,"restart_time":1,"pm_err_log_path":"/logs/archive.err"}},
 {"name":"multica-relay-advance","pm2_env":{"pm_exec_path":"$fixture/release/ops/belt/app","status":"online","unstable_restarts":0,"restart_time":1,"pm_err_log_path":"/logs/relay.err"}}]
JSON
EOF
chmod +x "$fixture/bin/pm2"
output=$(PATH="$fixture/bin:$PATH" "$root_dir/belt-status.sh" --release "$fixture/release" --worker-restart-burst-threshold 5 --worker-restart-burst-state "$fixture/burst.json" 2>&1)
grep -q 'release commit = ' <<<"$output"
grep -q 'gsp-multica-worker -> ' <<<"$output"
grep -q 'restart_burst app=gsp-multica-worker.*pm2_error_log=/logs/worker.err' <<<"$output"
if PATH="$fixture/bin:$PATH" "$root_dir/belt-status.sh" --release "$fixture/release" --baseline-worker-unstable-restarts 3 --worker-restart-burst-state "$fixture/burst2.json" >/dev/null 2>&1; then
  echo 'worker restart increase unexpectedly accepted' >&2; exit 1
fi
echo 'belt status tests: PASS'
