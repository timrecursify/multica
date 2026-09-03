#!/usr/bin/env bash
set -euo pipefail

# Compatibility entrypoint; the belt wrapper is the single implementation.
exec "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../belt" && pwd)/multica-daemon-wrapper.sh" "$@"
