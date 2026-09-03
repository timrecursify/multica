#!/bin/bash
set -euo pipefail
# Runs the relay-advance launcher from the same release directory this wrapper
# was installed into (self-relative: works from any immutable checkout).
exec /usr/bin/node "$(cd "$(dirname "$0")" && pwd)/multica-relay-advance-launcher.cjs"
