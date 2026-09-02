#!/bin/bash
set -euo pipefail

# gsp-multica-worker PM2 entrypoint.
#
# Secret files, host tool binary and daemon install are deliberately NOT
# hard-coded: they are named by environment variables with sane documented
# defaults (see ops/gsp-belt/README.md, "Host dependencies"). The tracked
# runtime itself is self-relative, so the same script serves every immutable
# release checkout instead of pointing back at a home-directory copy.

# Paid OpenRouter lane, authorized by Tim on 2026-08-30: he funded the OpenRouter
# account and ordered the DeepSeek build lane back online. codex-native refuses the
# lane without this, so the opt-in is stated here rather than left implied.
export MULTICA_ALLOW_PAID_LANE="${MULTICA_ALLOW_PAID_LANE:-1}"

requested_codex_bin="${CODEX_BIN:-${GSP_BELT_CODEX_BIN:-/home/newadmin/tools/codex-native}}"
if [[ "$requested_codex_bin" == "/home/newadmin/tools/codex-openrouter" ]]; then
  if [[ "${MULTICA_ALLOW_PAID_LANE:-}" != "1" ]]; then
    echo "multica-daemon-wrapper: refusing paid OpenRouter lane; set MULTICA_ALLOW_PAID_LANE=1 explicitly" >&2
    exit 64
  fi
  selected_lane="paid-openrouter"
else
  selected_lane="non-paid"
fi
export CODEX_BIN="$requested_codex_bin"
echo "multica-daemon-wrapper: lane=$selected_lane CODEX_BIN=$CODEX_BIN paid_opt_in=${MULTICA_ALLOW_PAID_LANE:-0}" >&2

# Operator secret files, externalized per ops/gsp-belt (never committed).
_secrets_dir="${GSP_BELT_SECRETS_DIR:-/home/newadmin/.secrets}"
if [[ -f "$_secrets_dir/deepseek.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$_secrets_dir/deepseek.env"
  set +a
fi
# The daemon sanitizes the environment it hands to codex, so the key must be in
# the daemon's own env to reach the child. Without this it passed an EMPTY
# OPENROUTER_API_KEY down and every paid-lane task died before any API call.
if [[ -f "$_secrets_dir/openrouter.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$_secrets_dir/openrouter.env"
  set +a
fi
export DEEPSEEK_MODEL="${DEEPSEEK_MODEL:-deepseek-ai/deepseek-v4-flash-0731}"
export MULTICA_DAEMON_PORT="${MULTICA_DAEMON_PORT:-20464}"

# Host-only daemon install directory (the multica server binary is built and
# installed separately; not part of this tracked subtree).
daemon_dir="${MULTICA_DAEMON_DIR:-/home/newadmin/multica-daemon}"
cd "$daemon_dir"

exec "$daemon_dir/server" daemon start \
  --foreground \
  --daemon-id=gsp-multica-worker \
  --max-concurrent-tasks=20 \
  --heartbeat-interval=30s \
  --poll-interval=2s \
  --workspaces-root="${GSP_WORKSPACES_ROOT:-/home/newadmin/multica-workspaces-gsp}"
