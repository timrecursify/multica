#!/usr/bin/env bash
set -euo pipefail
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
release="$fixture/release"
mkdir -p "$release/ops/belt"
printf '{"commit_sha":"0123456789abcdef0123456789abcdef01234567"}\n' > "$release/.gsp-belt-release.json"
cat > "$fixture/pm2" <<'EOF'
#!/usr/bin/env bash
cat <<'JSON'
[{"name":"gsp-multica-bridge","pm2_env":{"pm_exec_path":"RELEASE/ops/belt/bridge","status":"online","unstable_restarts":0,"restart_time":1}},
{"name":"gsp-multica-worker","pm2_env":{"pm_exec_path":"RELEASE/ops/belt/worker","status":"online","unstable_restarts":2,"restart_time":1,"pm_err_log_path":"/var/log/worker.err"}},
{"name":"multica-cicd-worker","pm2_env":{"pm_exec_path":"RELEASE/ops/belt/cicd","status":"online","unstable_restarts":0,"restart_time":1}},
{"name":"multica-archiver","pm2_env":{"pm_exec_path":"RELEASE/ops/belt/archive","status":"online","unstable_restarts":0,"restart_time":1}},
{"name":"multica-relay-advance","pm2_env":{"pm_exec_path":"RELEASE/ops/belt/relay","status":"online","unstable_restarts":0,"restart_time":1}}]
JSON
EOF
sed -i "s|RELEASE|$release|g" "$fixture/pm2"
chmod +x "$fixture/pm2"
out="$fixture/out"; state="$fixture/state.json"
PM2="$fixture/pm2" bash "$root_dir/belt-status.sh" --release "$release" --worker-restart-burst-state "$state" >"$out"
grep -q "release commit = 0123456789abcdef0123456789abcdef01234567" "$out"
grep -q "gsp-multica-worker.*status=online" "$out"
grep -q "restart_burst app=gsp-multica-worker count=0\|restart_burst app=gsp-multica-worker count=2" "$out"
if PM2="$fixture/pm2" bash "$root_dir/belt-status.sh" --release "$release" --baseline-worker-unstable-restarts 0 --worker-restart-burst-state "$state" >/dev/null 2>"$fixture/err"; then
  echo 'worker restart increase unexpectedly accepted' >&2; exit 1
fi
grep -q 'worker unstable_restarts increased' "$fixture/err"
echo 'belt status reporting regression passed'
