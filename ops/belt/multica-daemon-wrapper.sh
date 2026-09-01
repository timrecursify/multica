#!/usr/bin/env bash
set -euo pipefail

# Paid lane remains explicitly opt-in.
export MULTICA_ALLOW_PAID_LANE="${MULTICA_ALLOW_PAID_LANE:-0}"
requested_codex_bin="${CODEX_BIN:-/home/newadmin/tools/codex-native}"
if [[ "$requested_codex_bin" == "/home/newadmin/tools/codex-openrouter" && "${MULTICA_ALLOW_PAID_LANE}" != 1 ]]; then
  echo "multica-daemon-wrapper: refusing paid OpenRouter lane; set MULTICA_ALLOW_PAID_LANE=1 explicitly" >&2
  exit 64
fi
export CODEX_BIN="$requested_codex_bin"

cap_raw="${MULTICA_DAEMON_MAX_CONCURRENT_TASKS-20}"
root="${MULTICA_DAEMON_WORKSPACES_ROOT-/home/newadmin/multica-workspaces-gsp}"
if [[ ! "$cap_raw" =~ ^[1-9][0-9]*$ ]]; then
  echo "multica-daemon-wrapper: MULTICA_DAEMON_MAX_CONCURRENT_TASKS must be a positive integer" >&2
  exit 64
fi
if [[ -z "$root" || "$root" != /* ]]; then
  echo "multica-daemon-wrapper: MULTICA_DAEMON_WORKSPACES_ROOT must be an absolute path" >&2
  exit 64
fi
export MULTICA_DAEMON_MAX_CONCURRENT_TASKS="$cap_raw"
export MULTICA_DAEMON_WORKSPACES_ROOT="$root"

daemon_bin="${MULTICA_DAEMON_BIN:-/home/newadmin/multica-daemon/server}"
export MULTICA_DAEMON_PORT="${MULTICA_DAEMON_PORT:-20464}"
cd /home/newadmin/multica-daemon
exec "$daemon_bin" daemon start --foreground --daemon-id=gsp-multica-worker \
  --heartbeat-interval=30s --poll-interval=2s --workspaces-root="$root"
