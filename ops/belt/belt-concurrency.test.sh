#!/usr/bin/env bash
set -euo pipefail
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export BELT_CPU_COUNT_CMD='printf 12' BELT_IDLE_RUNNER_COUNT_CMD='printf 2'
[[ "$(source "$root_dir/belt-concurrency.sh"; belt_resolve_concurrency)" == 2 ]]
export BELT_IDLE_RUNNER_COUNT_CMD='printf 0'; [[ "$(source "$root_dir/belt-concurrency.sh"; belt_resolve_concurrency)" == 0 ]]
export BELT_IDLE_RUNNER_COUNT_CMD='printf 20'; [[ "$(source "$root_dir/belt-concurrency.sh"; belt_resolve_concurrency)" == 12 ]]
echo 'belt concurrency resolver tests passed'
