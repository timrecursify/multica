#!/usr/bin/env bash
set -euo pipefail

# Paid lane remains explicitly opt-in.
export MULTICA_ALLOW_PAID_LANE="${MULTICA_ALLOW_PAID_LANE:-0}"
requested_codex_bin="${CODEX_BIN:-/home/newadmin/tools/codex-native}"
if [[ "$requested_codex_bin" == "/home/newadmin/tools/codex-openrouter" && "$MULTICA_ALLOW_PAID_LANE" != 1 ]]; then
  echo "multica-daemon-wrapper: refusing paid OpenRouter lane; set MULTICA_ALLOW_PAID_LANE=1 explicitly" >&2
  exit 64
fi
export CODEX_BIN="$requested_codex_bin"

cap_raw="${MULTICA_DAEMON_MAX_CONCURRENT_TASKS-32}"
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
# Current daemon binaries consume this environment variable. Keep the fleet
# wrapper variable above for the belt guard and rollback scripts.
export MULTICA_WORKSPACES_ROOT="$root"

lock_file="${MULTICA_DAEMON_LOCK_FILE:-/home/newadmin/.local/state/gsp-multica-worker.lock}"
mkdir -p -- "$(dirname -- "$lock_file")"
exec 9>"$lock_file"
if ! flock -n 9; then
  echo "multica-daemon-wrapper: refusing duplicate gsp-multica-worker start" >&2
  exit 75
fi

daemon_bin="${MULTICA_DAEMON_BIN:-/home/newadmin/multica-daemon/server}"
daemon_cwd="${MULTICA_DAEMON_CWD:-/home/newadmin/multica-daemon}"
if [[ -z "$daemon_cwd" || "$daemon_cwd" != /* || ! -d "$daemon_cwd" ]]; then
  echo "multica-daemon-wrapper: MULTICA_DAEMON_CWD must be an existing absolute directory" >&2
  exit 64
fi
export MULTICA_DAEMON_PORT="${MULTICA_DAEMON_PORT:-20464}"
cd -- "$daemon_cwd"
daemon_help="$($daemon_bin daemon start --help 2>&1)" || {
  echo "multica-daemon-wrapper: unable to inspect daemon start capabilities" >&2
  exit 64
}
daemon_args=(daemon start --foreground --daemon-id=gsp-multica-worker
  --heartbeat-interval=30s --poll-interval=2s --max-concurrent-tasks="$cap_raw")
# `--workspaces-root` was removed from a short-lived daemon release. The
# environment setting is its documented replacement; old rollback artifacts
# still need the flag, so detect the installed binary rather than guessing a
# version string.
if grep -Fq -- '--workspaces-root' <<<"$daemon_help"; then
  daemon_args+=(--workspaces-root="$root")
fi
exec "$daemon_bin" "${daemon_args[@]}"
