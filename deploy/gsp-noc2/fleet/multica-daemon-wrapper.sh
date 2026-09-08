#!/bin/bash
set -euo pipefail

# Paid OpenRouter lane, authorized by Tim on 2026-08-30: he funded the OpenRouter
# account and ordered the DeepSeek build lane back online. codex-native refuses the
# lane without this, so the opt-in is stated here rather than left implied.
export MULTICA_ALLOW_PAID_LANE="${MULTICA_ALLOW_PAID_LANE:-1}"

requested_codex_bin="${CODEX_BIN:-/home/newadmin/tools/codex-native}"
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
set -a
source /home/newadmin/.secrets/deepseek.env
# The daemon sanitizes the environment it hands to codex, so the key must be in
# the daemon's own env to reach the child. Without this it passed an EMPTY
# OPENROUTER_API_KEY down and every paid-lane task died before any API call.
source /home/newadmin/.secrets/openrouter.env
set +a
export DEEPSEEK_MODEL="${DEEPSEEK_MODEL:-deepseek-ai/deepseek-v4-flash-0731}"
export MULTICA_DAEMON_PORT=20464
cd /home/newadmin/multica-daemon

exec /home/newadmin/multica-daemon/server daemon start \
  --foreground \
  --daemon-id=gsp-multica-worker \
  --max-concurrent-tasks=5 \
  --heartbeat-interval=30s \
  --poll-interval=2s \
  --workspaces-root=/home/newadmin/multica-workspaces-gsp
