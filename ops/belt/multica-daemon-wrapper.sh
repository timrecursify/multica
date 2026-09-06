#!/usr/bin/env bash
# shellcheck disable=SC1091
set -euo pipefail

# Keep the runtime lane and operator-owned identity explicit.  The deployed
# wrapper historically supplied these values from daemon.env; retaining the
# defaults here makes a source checkout safe to deploy while still allowing
# the host environment to override non-sensitive settings deliberately.
if [[ -r /etc/gsp/multica/daemon.env && "${BELT_TEST_MODE:-0}" != 1 ]]; then
  set -a
  # shellcheck disable=SC1091
  source /etc/gsp/multica/daemon.env
  set +a
fi
export HOME="${HOME:-/var/lib/gsp-multica}"
export CODEX_HOME="${CODEX_HOME:-/var/lib/gsp-multica/.codex}"
export CODEX_BIN="${CODEX_BIN:-/usr/local/bin/codex}"
export MULTICA_MODEL="${MULTICA_MODEL:-gpt-5.6-luna}"
export MULTICA_PROVIDER="${MULTICA_PROVIDER:-openai}"

# A belt task that restarts this worker leaks its own task context into pm2's
# saved process definition. The daemon then refuses every start with
# "daemon start is not available inside a daemon-managed task", and pm2
# re-injects the same environment on every retry, so the worker can never
# recover on its own. This process is the supervisor, never a task.
unset MULTICA_TASK_ID MULTICA_TASK_SLOT MULTICA_TASK_CONFIG_ROOT \
      MULTICA_TASK_WORKSPACES_ROOT MULTICA_AGENT_ID

# Paid lane remains explicitly opt-in.
export MULTICA_ALLOW_PAID_LANE="${MULTICA_ALLOW_PAID_LANE:-0}"
requested_codex_bin="${CODEX_BIN:-/var/lib/gsp/tools/codex-native}"
if [[ "$requested_codex_bin" == "/var/lib/gsp/tools/codex-openrouter" && "$MULTICA_ALLOW_PAID_LANE" != 1 ]]; then
  echo "multica-daemon-wrapper: refusing paid OpenRouter lane; set MULTICA_ALLOW_PAID_LANE=1 explicitly" >&2
  exit 64
fi
export CODEX_BIN="$requested_codex_bin"

# The belt executes repository build commands through this process. Keep the
# system Go toolchain ahead of inherited user paths for every task.
export PATH="/usr/local/go/bin:${PATH}"
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/belt-concurrency.sh"
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/workspace-root.sh"

cpu_count="$(belt_cpu_count)" || exit 64
cap_raw="${MULTICA_DAEMON_MAX_CONCURRENT_TASKS-}"
root="${MULTICA_DAEMON_WORKSPACES_ROOT-$BELT_CANONICAL_WORKSPACES_ROOT}"
help_timeout="${MULTICA_DAEMON_HELP_TIMEOUT_SECONDS:-5}"
if [[ -n "${MULTICA_DAEMON_MAX_CONCURRENT_TASKS+x}" && ! "$cap_raw" =~ ^[0-9]+$ ]]; then
  echo "multica-daemon-wrapper: MULTICA_DAEMON_MAX_CONCURRENT_TASKS must be a non-negative integer" >&2
  exit 64
fi
if [[ -z "$cap_raw" ]]; then cap_raw="$(belt_resolve_concurrency)" || exit 64; fi
if (( cap_raw > cpu_count )); then
  echo "multica-daemon-wrapper: MULTICA_DAEMON_MAX_CONCURRENT_TASKS must not exceed CPU count ($cpu_count)" >&2
  exit 64
fi
if ! root="$(workspace_root_validate 2>&1)"; then
  echo "multica-daemon-wrapper: ${root##*$'\n'}" >&2
  exit 64
fi
if [[ ! "$help_timeout" =~ ^[1-9][0-9]*$ ]]; then
  echo "multica-daemon-wrapper: MULTICA_DAEMON_HELP_TIMEOUT_SECONDS must be a positive integer" >&2
  exit 64
fi
export MULTICA_DAEMON_MAX_CONCURRENT_TASKS="$cap_raw"
export MULTICA_DAEMON_WORKSPACES_ROOT="$root"
# Current daemon binaries consume this environment variable. Keep the fleet
# wrapper variable above for the belt guard and rollback scripts.
export MULTICA_WORKSPACES_ROOT="$root"

lock_file="${MULTICA_DAEMON_LOCK_FILE:-/var/lib/gsp/.local/state/gsp-multica-worker.lock}"
mkdir -p -- "$(dirname -- "$lock_file")"
exec 9>"$lock_file"
if ! flock -n 9; then
  echo "multica-daemon-wrapper: refusing duplicate gsp-multica-worker start" >&2
  exit 75
fi

daemon_bin="${MULTICA_DAEMON_BIN:-/var/lib/gsp/multica-daemon/server}"
daemon_cwd="${MULTICA_DAEMON_CWD:-/var/lib/gsp/multica-daemon}"
if [[ -z "$daemon_cwd" || "$daemon_cwd" != /* || ! -d "$daemon_cwd" ]]; then
  echo "multica-daemon-wrapper: MULTICA_DAEMON_CWD must be an existing absolute directory" >&2
  exit 64
fi
requested_daemon_port="${MULTICA_DAEMON_PORT-}"
requested_health_port="${MULTICA_HEALTH_PORT-}"
if [[ -n "$requested_daemon_port" && -n "$requested_health_port" && "$requested_daemon_port" != "$requested_health_port" ]]; then
  echo "multica-daemon-wrapper: MULTICA_DAEMON_PORT ($requested_daemon_port) disagrees with MULTICA_HEALTH_PORT ($requested_health_port)" >&2
  exit 64
fi
effective_health_port="${requested_daemon_port:-${requested_health_port:-20464}}"
if [[ ! "$effective_health_port" =~ ^[1-9][0-9]*$ || "$effective_health_port" -gt 65535 ]]; then
  echo "multica-daemon-wrapper: effective health port must be an integer from 1 to 65535" >&2
  exit 64
fi
export MULTICA_DAEMON_PORT="$effective_health_port"
export MULTICA_HEALTH_PORT="$effective_health_port"
cd -- "$daemon_cwd"
set +e
daemon_help="$(timeout --kill-after=1s "${help_timeout}s" "$daemon_bin" daemon start --help 2>&1)"
help_status=$?
set -e
if [[ $help_status -eq 124 ]]; then
  echo "multica-daemon-wrapper: daemon start capability probe timed out" >&2
  exit 64
fi
if [[ $help_status -ne 0 ]]; then
  echo "multica-daemon-wrapper: daemon start capability probe failed (exit $help_status)" >&2
  exit 64
fi
daemon_args=(daemon start --foreground --profile=gsp-codex --daemon-id=gsp-codex
  --heartbeat-interval=30s --poll-interval=2s --max-concurrent-tasks="$cap_raw")
# `--workspaces-root` was removed from a short-lived daemon release. The
# environment setting is its documented replacement; old rollback artifacts
# still need the flag, so detect the installed binary rather than guessing a
# version string.
if grep -Fq -- '--workspaces-root' <<<"$daemon_help"; then
  daemon_args+=(--workspaces-root="$root")
fi
# Validate the complete argument vector against the installed binary.  This
# turns a binary/wrapper drift into an actionable startup failure instead of
# an opaque PM2 crash loop.  Help output is intentionally the source of truth
# so rollback binaries with a different option set remain supported.
for arg in "${daemon_args[@]:2}"; do
  [[ "$arg" == --* ]] || continue
  flag="${arg%%=*}"
  if ! grep -Eq -- "(^|[[:space:]])${flag}([=[:space:]]|$)" <<<"$daemon_help"; then
    echo "unknown daemon start flag: $flag" >&2
    exit 64
  fi
done
"$daemon_bin" "${daemon_args[@]}" &
server_pid=$!

# The scoping leg is part of the worker's runtime contract.  Start it only
# when the deployed artifact is present so unit fixtures and rollback images
# can still exercise the daemon wrapper in isolation.
scoping_driver="${MULTICA_SCOPING_DRIVER:-$(dirname -- "${BASH_SOURCE[0]}")/scoping-claude-driver.sh}"
if [[ -x "$scoping_driver" ]]; then
  scoping_log="${MULTICA_SCOPING_DRIVER_LOG:-/var/lib/gsp-multica/scoping-claude-driver.log}"
  mkdir -p -- "$(dirname -- "$scoping_log")"
  "$scoping_driver" >>"$scoping_log" 2>&1 &
fi

wait "$server_pid"
