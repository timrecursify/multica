#!/usr/bin/env bash
set -euo pipefail
interval="${MULTICA_DAEMON_HEALTH_INTERVAL_SECONDS:-60}"
while :; do
  node "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/daemon-health-sentinel.cjs"
  sleep "$interval"
done
