#!/usr/bin/env bash
# shellcheck disable=SC1091
set -euo pipefail

preflight_blocker() {
  printf 'PREFLIGHT_BLOCKER code=%s recoverable=true retry_consumed=false disposition=queued resume=same_work_product detail=%s\n' \
    "$1" "$2" >&2
  exit 75
}

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
  preflight_blocker environment_keys_missing MULTICA_DAEMON_ENV_FILE
fi

# A belt task that restarts this worker leaks its own task context into pm2's
# saved process definition. The daemon then refuses every start with
# "daemon start is not available inside a daemon-managed task", and pm2
# re-injects the same environment on every retry, so the worker can never
# recover on its own. This process is the supervisor, never a task.
unset MULTICA_TASK_ID MULTICA_TASK_SLOT MULTICA_TASK_CONFIG_ROOT \
      MULTICA_TASK_WORKSPACES_ROOT MULTICA_AGENT_ID

default_codex_path='/opt/gsp-noc/providers/codex/bin/codex.js'
# The daemon consumes MULTICA_CODEX_PATH. Keep CODEX_BIN as the belt guard's
# compatibility variable, while pinning the default to the provider directly.
requested_codex_bin="${MULTICA_CODEX_PATH:-${CODEX_BIN:-$default_codex_path}}"
if [[ "$requested_codex_bin" == */codex-openrouter ]]; then
  preflight_blocker routing_not_allowed legacy_provider_path
fi
export CODEX_BIN="$requested_codex_bin"
export MULTICA_CODEX_PATH="$requested_codex_bin"

# The belt executes repository build commands through this process. Keep the
# system Go toolchain ahead of inherited user paths for every task.
export PATH="/usr/local/go/bin:${PATH}"
wrapper_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$wrapper_dir/belt-concurrency.sh"
source "$wrapper_dir/workspace-root.sh"

resolve_routing_config() {
  local candidate
  if [[ -n "${MULTICA_BELT_ROUTING_CONFIG-}" ]]; then
    printf '%s\n' "$MULTICA_BELT_ROUTING_CONFIG"
    return
  fi
  for candidate in "$wrapper_dir/qc-lane.cjs" \
    "$wrapper_dir/../gsp-multica-bridge/qc-lane.cjs" "$wrapper_dir/../qc-lane.cjs"; do
    if [[ -r "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  return 1
}

validate_required_environment() {
  local raw key value
  local -a keys=() missing=()
  raw="MULTICA_TOKEN,MULTICA_DAEMON_ALLOWED_PROVIDERS,MULTICA_CODEX_MODEL"
  raw+="${MULTICA_BELT_REQUIRED_ENV_KEYS:+,$MULTICA_BELT_REQUIRED_ENV_KEYS}"
  IFS=',' read -r -a keys <<<"$raw"
  for key in "${keys[@]}"; do
    key="${key//[[:space:]]/}"
    [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || preflight_blocker environment_keys_missing invalid_key_name
    value="${!key-}"
    [[ -n "$value" ]] || missing+=("$key")
  done
  ((${#missing[@]} == 0)) || preflight_blocker environment_keys_missing "keys:$(IFS=,; echo "${missing[*]}")"
}

base64url() {
  openssl base64 -A | tr '+/' '-_' | tr -d '='
}

load_github_app_environment() {
  local app_env="${MULTICA_BELT_GITHUB_APP_ENV:-/etc/gsp/gh-app/gsp.env}"
  [[ -r "$app_env" ]] || preflight_blocker environment_keys_missing MULTICA_BELT_GITHUB_APP_ENV
  set -a
  # shellcheck source=/dev/null
  source "$app_env"
  set +a
  local -a missing=()
  [[ -n "${GH_APP_ID-}" ]] || missing+=(GH_APP_ID)
  [[ -n "${GH_APP_PEM-}" ]] || missing+=(GH_APP_PEM)
  ((${#missing[@]} == 0)) || preflight_blocker environment_keys_missing "keys:$(IFS=,; echo "${missing[*]}")"
  [[ -r "$GH_APP_PEM" ]] || preflight_blocker environment_keys_missing GH_APP_PEM
}

probe_repository_permissions() {
  local repository="$1" now header payload signature response
  if [[ -n "${MULTICA_BELT_REPOSITORY_PERMISSION_PROBE-}" ]]; then
    "$MULTICA_BELT_REPOSITORY_PERMISSION_PROBE" "$repository" >/dev/null 2>&1
    return
  fi
  load_github_app_environment
  now="$(date +%s)"
  header="$(printf '%s' '{"alg":"RS256","typ":"JWT"}' | base64url)"
  payload="$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' "$((now - 60))" "$((now + 540))" "$GH_APP_ID" | base64url)"
  signature="$(printf '%s' "$header.$payload" | openssl dgst -sha256 -sign "$GH_APP_PEM" -binary | base64url)"
  response="$(printf 'header = "Authorization: Bearer %s"\nheader = "Accept: application/vnd.github+json"\n' \
    "$header.$payload.$signature" | curl --silent --show-error --fail --max-time "$help_timeout" --config - \
    "https://api.github.com/repos/$repository/installation" 2>/dev/null)" || return 1
  printf '%s' "$response" | "$node_bin" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const p=JSON.parse(d).permissions||{};process.exit(["contents","pull_requests","workflows"].every(k=>p[k]==="write")?0:1)}catch{process.exit(1)}})'
}

probe_deployment_owner() {
  local owner
  local owners="${MULTICA_BELT_DEPLOYMENT_OWNERS:-ppp-prod,pi-mesh}"
  local -a owner_list=()
  IFS=',' read -r -a owner_list <<<"$owners"
  for owner in "${owner_list[@]}"; do
    owner="${owner//[[:space:]]/}"
    [[ "$owner" =~ ^[A-Za-z0-9._-]+$ ]] || continue
    if timeout --kill-after=1s "${help_timeout}s" "$ssh_bin" -o BatchMode=yes \
      -o "ConnectTimeout=$help_timeout" -o ConnectionAttempts=1 "$owner" true </dev/null >/dev/null 2>&1; then
      return 0
    fi
  done
  return 1
}

run_capability_preflight() {
  local routing_error routing_config repository
  validate_required_environment
  routing_config="$(resolve_routing_config)" || preflight_blocker routing_not_allowed routing_config_unavailable
  [[ -r "$routing_config" ]] || preflight_blocker routing_not_allowed routing_config_unreadable
  if ! routing_error="$("$node_bin" "$routing_config" validate-daemon \
    "$MULTICA_DAEMON_ALLOWED_PROVIDERS" "$MULTICA_CODEX_MODEL" 2>&1)"; then
    preflight_blocker routing_not_allowed "${routing_error:-route_validation_failed}"
  fi
  "$node_bin" "$routing_config" worker-instructions build >/dev/null 2>&1 || \
    preflight_blocker routing_not_allowed worker_instruction_generation_failed
  repository="${MULTICA_BELT_REPOSITORY:-timrecursify/multica}"
  [[ "$repository" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || \
    preflight_blocker repository_push_unavailable invalid_repository
  probe_repository_permissions "$repository" || preflight_blocker repository_push_unavailable \
    required:contents_write,pull_requests_write,workflows_write
  probe_deployment_owner || preflight_blocker deployment_owner_unreachable \
    "aliases:${MULTICA_BELT_DEPLOYMENT_OWNERS:-ppp-prod,pi-mesh}"
}

cpu_count="$(belt_cpu_count)" || exit 64
cap_raw="${MULTICA_DAEMON_MAX_CONCURRENT_TASKS-}"
root="${MULTICA_DAEMON_WORKSPACES_ROOT-$BELT_CANONICAL_WORKSPACES_ROOT}"
help_timeout="${MULTICA_DAEMON_HELP_TIMEOUT_SECONDS:-5}"
node_bin="${MULTICA_BELT_NODE_BIN:-node}"
ssh_bin="${MULTICA_BELT_SSH_BIN:-ssh}"
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
if [[ "${BELT_TEST_MODE-0}" != 1 || "${BELT_WRAPPER_TEST-0}" != 1 || \
      "${BELT_PREFLIGHT_TEST_MODE-0}" == 1 ]]; then
  run_capability_preflight
fi
set +e
daemon_help="$(timeout --kill-after=1s "${help_timeout}s" "$daemon_bin" daemon start --help 2>&1)"
help_status=$?
set -e
if [[ $help_status -eq 124 ]]; then
  preflight_blocker daemon_capability_unavailable help_timeout
fi
if [[ $help_status -ne 0 ]]; then
  preflight_blocker daemon_capability_unavailable "help_exit:$help_status"
fi
# Identity and cadence come from the daemon environment. Hardcoding them here
# silently renamed the running daemon, and a daemon-id that disagrees with its
# token is rejected as "daemon_id does not match token".
daemon_args=(daemon start --foreground
  --daemon-id="${MULTICA_DAEMON_ID:-gsp-multica-worker}"
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
    preflight_blocker daemon_capability_unavailable "unknown_flag:$flag"
  fi
done

# --profile is accepted by the installed daemon but is absent from its help, so
# it is appended after the help-driven check rather than being rejected by it.
# It is opt-in: without it the daemon uses its own default profile.
if [[ -n "${MULTICA_DAEMON_PROFILE-}" ]]; then
  daemon_args+=(--profile="$MULTICA_DAEMON_PROFILE")
fi

# Run the daemon as a child rather than exec-ing it, so this process stays the
# unit's main process. Scoping is routed through the fleet-approved OpenAI
# runtime and is not launched as a legacy sidecar provider.
"$daemon_bin" "${daemon_args[@]}" &
daemon_pid=$!
set +e
wait "$daemon_pid"
daemon_status=$?
set -e
exit "$daemon_status"
