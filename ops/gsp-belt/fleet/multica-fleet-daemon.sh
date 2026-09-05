#!/bin/bash
set -euo pipefail
# gsp-multica-fleet daemon entrypoint. Host secrets/tool paths are externalized
# via env with documented defaults (see README.md "Host dependencies"); the
# tracked script is self-relative and env-driven.
export CODEX_BIN="${GSP_BELT_CODEX_BIN:-${CODEX_BIN:-/home/newadmin/tools/codex-openrouter}}"
_secrets_dir="${GSP_BELT_SECRETS_DIR:-/home/newadmin/.secrets}"
if [[ -f "$_secrets_dir/openrouter.env" ]]; then
  set -a; source "$_secrets_dir/openrouter.env"; set +a
fi
if [[ -f "$_secrets_dir/deepseek.env" ]]; then
  set -a; source "$_secrets_dir/deepseek.env"; set +a
fi
if [[ -n "${GSP_BELT_ENV_FILE:-}" && -f "$GSP_BELT_ENV_FILE" ]]; then
  set -a; source "$GSP_BELT_ENV_FILE"; set +a
fi
requested_daemon_port="${MULTICA_DAEMON_PORT-}"
requested_health_port="${MULTICA_HEALTH_PORT-}"
if [[ -n "$requested_daemon_port" && -n "$requested_health_port" && "$requested_daemon_port" != "$requested_health_port" ]]; then
  echo "multica-fleet-daemon: MULTICA_DAEMON_PORT ($requested_daemon_port) disagrees with MULTICA_HEALTH_PORT ($requested_health_port)" >&2
  exit 64
fi
effective_health_port="${requested_daemon_port:-${requested_health_port:-20464}}"
if [[ ! "$effective_health_port" =~ ^[1-9][0-9]*$ || "$effective_health_port" -gt 65535 ]]; then
  echo "multica-fleet-daemon: effective health port must be an integer from 1 to 65535" >&2
  exit 64
fi
export MULTICA_DAEMON_PORT="$effective_health_port"
export MULTICA_HEALTH_PORT="$effective_health_port"
export MULTICA_WORKSPACES_ROOT="${GSP_WORKSPACES_ROOT:-${GSP_BELT_WORKSPACES_ROOT:-/home/newadmin/multica-workspaces-gsp}}"
daemon_dir="${MULTICA_DAEMON_DIR:-/home/newadmin/multica-daemon}"
cd "$daemon_dir"
exec ./server daemon start --foreground --profile=noc2-codex --daemon-id=gsp-multica-fleet --max-concurrent-tasks=5 --heartbeat-interval=30s --poll-interval=2s --workspaces-root="${MULTICA_WORKSPACES_ROOT}"
