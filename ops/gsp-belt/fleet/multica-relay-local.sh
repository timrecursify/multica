#!/bin/bash
set -euo pipefail
# Local manual relay: run the bridge from the same release directory this
# script was installed into (self-relative, so it serves any immutable release).
export PORT="${PORT:-5006}"
self="$(cd "$(dirname "$0")" && pwd)"
exec /usr/bin/env node "$self/../bridge/multica-bridge.cjs"
