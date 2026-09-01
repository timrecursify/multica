#!/usr/bin/env bash
# Supervised PPP Multica daemon entrypoint. The lock is held across exec so a
# second service instance cannot claim the same workspace root.
set -euo pipefail

DAEMON_BIN="${MULTICA_DAEMON_BIN:-}"
WORKSPACES_ROOT="${MULTICA_WORKSPACES_ROOT:-/var/lib/multica-ppp/workspaces}"
LOCK_FILE="${MULTICA_DAEMON_LOCK_FILE:-$HOME/.cache/multica/ppp-daemon.lock}"

if [[ -z "$DAEMON_BIN" ]]; then
  echo "multica PPP daemon: MULTICA_DAEMON_BIN is required" >&2
  exit 78
fi
if [[ "$WORKSPACES_ROOT" != /* ]]; then
  echo "multica PPP daemon: MULTICA_WORKSPACES_ROOT must be absolute" >&2
  exit 78
fi
if [[ ! -x "$DAEMON_BIN" ]]; then
  echo "multica PPP daemon: executable not found: $DAEMON_BIN" >&2
  exit 78
fi
mkdir -p "$WORKSPACES_ROOT" "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "multica PPP daemon: duplicate instance for $WORKSPACES_ROOT" >&2
  exit 75
fi

exec "$DAEMON_BIN" daemon start --foreground \
  --profile=ppp-prod-codex \
  --daemon-id=ppp-prod-codex \
  --max-concurrent-tasks=2 \
  --heartbeat-interval=30s \
  --poll-interval=5s \
  --no-auto-update \
  --no-auto-reload
