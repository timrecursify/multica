#!/usr/bin/env bash
set -euo pipefail
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
release="$fixture/release"
mkdir -p "$release/ops/belt" "$fixture/.local/state"
printf '{"commit_sha":"0123456789012345678901234567890123456789"}\n' >"$release/.gsp-belt-release.json"
cat >"$fixture/pm2" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' '[{"name":"gsp-multica-bridge","pm2_env":{"pm_exec_path":"RELEASE/ops/belt/app","status":"online","unstable_restarts":0,"restart_time":1,"pm_err_log_path":"/logs/bridge.err"}},{"name":"gsp-multica-worker","pm2_env":{"pm_exec_path":"RELEASE/ops/belt/app","status":"online","unstable_restarts":0,"restart_time":1,"pm_err_log_path":"/logs/worker.err"}},{"name":"multica-cicd-worker","pm2_env":{"pm_exec_path":"RELEASE/ops/belt/app","status":"online"}},{"name":"multica-archiver","pm2_env":{"pm_exec_path":"RELEASE/ops/belt/app","status":"online"}},{"name":"multica-relay-advance","pm2_env":{"pm_exec_path":"RELEASE/ops/belt/app","status":"online"}}]' | sed "s#RELEASE#$GSP_TEST_RELEASE#g"
EOF
chmod +x "$fixture/pm2"
output=$(GSP_TEST_RELEASE="$release" PM2="$fixture/pm2" RUNTIME_ROOT="$fixture" GSP_WORKER_RESTART_BURST_STATE="$fixture/burst.json" bash "$root_dir/belt-status.sh" --release "$release")
grep -q "worker remediation = unreleased" <<<"$output"
grep -q "gsp-multica-worker.*pm_err_log_path" <<<"$output" || true
touch "$fixture/.local/state/multica-operator-release" "$fixture/.local/state/multica-supervisor-approval"
output=$(GSP_TEST_RELEASE="$release" PM2="$fixture/pm2" RUNTIME_ROOT="$fixture" GSP_WORKER_RESTART_BURST_STATE="$fixture/burst2.json" bash "$root_dir/belt-status.sh" --release "$release")
grep -q "worker remediation = released" <<<"$output"
echo "belt status regression passed"
