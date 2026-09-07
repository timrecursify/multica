#!/bin/bash
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
release="$root/release"; mkdir -p "$release"
printf '{"commit_sha":"0000000000000000000000000000000000000000"}\n' > "$release/.gsp-belt-release.json"
cat > "$root/pm2" <<'EOF'
#!/bin/bash
python3 - <<'PY'
import json
apps=['gsp-multica-bridge','gsp-multica-worker','multica-cicd-worker','multica-archiver','multica-relay-advance']
print(json.dumps([{'name':a,'pm2_env':{'pm_exec_path':'RELEASE/ops/belt/app.js','status':'online','unstable_restarts':0,'restart_time':0,'pm_err_log_path':'/var/log/'+a+'.err'}} for a in apps]))
PY
EOF
sed -i "s#RELEASE#$release#g" "$root/pm2"; chmod +x "$root/pm2"
state="$root/.local/state"; mkdir -p "$state"
run_status() { PM2="$root/pm2" MULTICA_RUNTIME_ROOT="$root" GSP_WORKER_RESTART_BURST_STATE="$root/burst" bash ops/gsp-belt/scripts/belt-status.sh --release "$release"; }
out=$(run_status); grep -q 'worker remediation release state = unreleased' <<<"$out"
touch "$state/multica-operator-release" "$state/multica-supervisor-approval"
out=$(run_status); grep -q 'worker remediation release state = released' <<<"$out"
touch "$state/multica-ai-hold"
out=$(run_status); grep -q 'worker remediation release state = held' <<<"$out"
echo 'belt status release-state regression passed'
