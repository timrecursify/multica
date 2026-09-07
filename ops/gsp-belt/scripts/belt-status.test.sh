#!/usr/bin/env bash
set -euo pipefail
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf -- "$fixture"' EXIT
mkdir -p "$fixture/release/ops/belt" "$fixture/bin"
printf '%s\n' '{"commit_sha":"0123456789abcdef0123456789abcdef01234567"}' > "$fixture/release/.gsp-belt-release.json"
cat > "$fixture/bin/pm2" <<'EOF'
#!/usr/bin/env bash
sed "s#RELEASE#${RELEASE_DIR}#g" <<'JSON'
[{"name":"gsp-multica-bridge","pm2_env":{"pm_exec_path":"RELEASE/ops/belt/bridge","status":"online","unstable_restarts":0,"restart_time":0,"pm_err_log_path":"/logs/bridge.err"}},{"name":"gsp-multica-worker","pm2_env":{"pm_exec_path":"RELEASE/ops/belt/worker","status":"online","unstable_restarts":1,"restart_time":1,"pm_err_log_path":"/logs/worker.err"}},{"name":"multica-cicd-worker","pm2_env":{"pm_exec_path":"RELEASE/ops/belt/cicd","status":"online","unstable_restarts":0,"restart_time":0,"pm_err_log_path":"/logs/cicd.err"}},{"name":"multica-archiver","pm2_env":{"pm_exec_path":"RELEASE/ops/belt/archive","status":"online","unstable_restarts":0,"restart_time":0,"pm_err_log_path":"/logs/archive.err"}},{"name":"multica-relay-advance","pm2_env":{"pm_exec_path":"RELEASE/ops/belt/relay","status":"online","unstable_restarts":0,"restart_time":0,"pm_err_log_path":"/logs/relay.err"}}]
JSON
EOF
chmod +x "$fixture/bin/pm2"
cp "$root_dir/belt-status.sh" "$fixture/status.sh"
chmod +x "$fixture/status.sh"
output=$(RELEASE_DIR="$fixture/release" PATH="$fixture/bin:$PATH" "$fixture/status.sh" --release "$fixture/release" --worker-restart-burst-state "$fixture/burst.json")
grep -q 'gsp-multica-worker -> .*status=online' <<<"$output"
grep -q 'pm2_error_log=/logs/worker.err' <<<"$output"
if RELEASE_DIR="$fixture/release" PATH="$fixture/bin:$PATH" "$fixture/status.sh" --release "$fixture/release" --baseline-worker-unstable-restarts 0 --worker-restart-burst-threshold 0 --worker-restart-burst-state "$fixture/burst2.json" >/dev/null 2>&1; then
  echo 'restart burst was not reported unhealthy' >&2; exit 1
fi
echo 'belt status regression passed'
