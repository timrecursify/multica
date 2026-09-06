#!/usr/bin/env bash
# shellcheck disable=SC1091
set -euo pipefail

# The gsp unit's only EnvironmentFile is claude-oauth.env, so this file is the
# single path by which MULTICA_TOKEN, the model pin, the provider and the daemon
# identity reach the daemon. Sourcing it is load-bearing: without it the worker
# starts unauthenticated and unpinned. The suites supply their own environment
# and opt out, so the file is required exactly when it is meant to be there.
daemon_env_file="${MULTICA_DAEMON_ENV_FILE:-/etc/gsp/multica/daemon.env}"
if [[ "${BELT_TEST_MODE-0}" == 1 ]]; then
  :
elif [[ -r "$daemon_env_file" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$daemon_env_file"
  set +a
else
  echo "multica-daemon-wrapper: daemon environment file is not readable: $daemon_env_file" >&2
  exit 64
fi

# Production routing is an explicit wrapper contract.  Keep these assignments
# after daemon.env sourcing so an ambient or stale env cannot silently redirect
# the worker to another model/provider lane.
export MULTICA_MODEL=gpt-5.6-luna
export MULTICA_PROVIDER=openai

# A belt task that restarts this worker leaks its own task context into pm2's
# saved process definition. The daemon then refuses every start with
# "daemon start is not available inside a daemon-managed task", and pm2
# re-injects the same environment on every retry, so the worker can never
# recover on its own. This process is the supervisor, never a task.
unset MULTICA_TASK_ID MULTICA_TASK_SLOT MULTICA_TASK_CONFIG_ROOT \
      MULTICA_TASK_WORKSPACES_ROOT MULTICA_AGENT_ID

# Paid lane remains explicitly opt-in.
export MULTICA_ALLOW_PAID_LANE="${MULTICA_ALLOW_PAID_LANE:-0}"
requested_codex_bin="${CODEX_BIN:-/usr/local/bin/codex}"
if [[ "$requested_codex_bin" == */codex-openrouter && "$MULTICA_ALLOW_PAID_LANE" != 1 ]]; then
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

daemon_bin="${MULTICA_DAEMON_BIN:-/opt/gsp/multica-workers/gsp-multica-worker/server}"
daemon_cwd="${MULTICA_DAEMON_CWD:-/opt/gsp/multica-workers/gsp-multica-worker}"
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
# Publish a port only when one was asked for. Exporting a default would bind a
# health listener the running deployment does not have, and a stale daemon
# holding that port is how the worker crash-looped before.
if [[ -n "$requested_daemon_port" || -n "$requested_health_port" ]]; then
  effective_health_port="${requested_daemon_port:-$requested_health_port}"
  if [[ ! "$effective_health_port" =~ ^[1-9][0-9]*$ || "$effective_health_port" -gt 65535 ]]; then
    echo "multica-daemon-wrapper: effective health port must be an integer from 1 to 65535" >&2
    exit 64
  fi
  export MULTICA_DAEMON_PORT="$effective_health_port"
  export MULTICA_HEALTH_PORT="$effective_health_port"
fi
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
# Identity and cadence come from the daemon environment. Hardcoding them here
# silently renamed the running daemon, and a daemon-id that disagrees with its
# token is rejected as "daemon_id does not match token".
daemon_args=(daemon start --foreground
  --daemon-id=gsp-codex
  --heartbeat-interval="${MULTICA_DAEMON_HEARTBEAT_INTERVAL:-30s}"
  --poll-interval="${MULTICA_DAEMON_POLL_INTERVAL:-2s}"
  --max-concurrent-tasks="$cap_raw")
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

# Profile is supported by the installed daemon but intentionally absent from
# older help output, so append the production profile after capability checks.
daemon_args+=(--profile=gsp-codex)

# The Claude scoping driver runs beside the worker and is what scopes tickets.
# It is supervised by this unit, so it starts here and not from a second unit.
scoping_driver="${MULTICA_SCOPING_DRIVER:-/opt/gsp/multica-workers/gsp-multica-worker/scoping-claude-driver.sh}"
scoping_log="${MULTICA_SCOPING_DRIVER_LOG:-/var/lib/gsp-multica/scoping-claude-driver.log}"
if [[ -x "$scoping_driver" ]]; then
  "$scoping_driver" >>"$scoping_log" 2>&1 &
fi

# Run the daemon as a child rather than exec-ing it, so this process stays the
# unit's main process and the scoping driver above keeps a live parent.
"$daemon_bin" "${daemon_args[@]}" &
daemon_pid=$!
set +e
wait "$daemon_pid"
daemon_status=$?
set -e
exit "$daemon_status"
