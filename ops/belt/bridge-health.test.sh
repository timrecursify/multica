#!/usr/bin/env bash
set -Eeuo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"; tmp="$(mktemp -d)"; trap 'rm -rf -- "$tmp"' EXIT
release="$tmp/release"; mkdir -p "$release/ops/belt"; printf '{"commit_sha":"0123456789012345678901234567890123456789"}\n' > "$release/.gsp-belt-release.json"
cat > "$tmp/pm2" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == jlist ]]; then
  [[ -f "$RESTART_MARK" ]] && STATUS=online RESTARTS=0
  printf '%s\n' "[{\"name\":\"gsp-multica-bridge\",\"pm2_env\":{\"status\":\"$STATUS\",\"unstable_restarts\":$RESTARTS,\"restart_time\":123,\"pm_exec_path\":\"$PATH_EXPECTED/ops/belt/multica-bridge.cjs\",\"exit_code\":$EXIT_CODE,\"exit_signal\":\"\"}}]"
else [[ "$1" == restart ]] && printf restart > "$RESTART_MARK"; fi
EOF
chmod +x "$tmp/pm2"
export PM2="$tmp/pm2" PATH_EXPECTED="$release" STATUS=online RESTARTS=0 EXIT_CODE=0 RESTART_MARK="$tmp/restarted"
"$root/bridge-health.sh" --release "$release" --baseline-unstable-restarts 0 >/dev/null
RESTARTS=1; if "$root/bridge-health.sh" --release "$release" --baseline-unstable-restarts 0 >/dev/null 2>&1; then echo 'incremented restarts unexpectedly passed' >&2; exit 1; fi
STATUS=stopped; if "$root/bridge-health.sh" --release "$release" >/dev/null 2>&1; then echo 'offline bridge unexpectedly passed' >&2; exit 1; fi
STATUS=stopped; RESTARTS=1; "$root/bridge-health.sh" --release "$release" --repair >/dev/null
[[ -f "$RESTART_MARK" ]]
PATH_EXPECTED="$tmp/other"; STATUS=online; RESTARTS=0; if "$root/bridge-health.sh" --release "$release" >/dev/null 2>&1; then echo 'wrong release unexpectedly passed' >&2; exit 1; fi
echo 'bridge health regression passed'
