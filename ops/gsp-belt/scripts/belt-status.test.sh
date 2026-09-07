#!/usr/bin/env bash
set -euo pipefail
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"; f="$(mktemp -d)"; trap 'rm -rf "$f"' EXIT
mkdir -p "$f/release/ops/belt" "$f/bin"; printf '%s\n' '{"commit_sha":"0123456789abcdef0123456789abcdef01234567"}' >"$f/release/.gsp-belt-release.json"
cat >"$f/bin/pm2" <<'EOF'
#!/bin/sh
cat "$PM2_FIXTURE"
EOF
chmod +x "$f/bin/pm2"; printf '[]\n' >"$f/pm2.json"
out=$(PATH="$f/bin:$PATH" PM2_FIXTURE="$f/pm2.json" MULTICA_AI_HOLD_FILE="$f/hold" MULTICA_OPERATOR_RELEASE_FILE="$f/release-approval" MULTICA_SUPERVISOR_APPROVAL_FILE="$f/supervisor" "$root_dir/belt-status.sh" --release "$f/release" --worker-restart-burst-state "$f/state" 2>&1 || true)
grep -q 'release_state = unreleased' <<<"$out"
echo 'belt status tests: PASS'
