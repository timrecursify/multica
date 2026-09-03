#!/usr/bin/env bash
set -euo pipefail
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export BELT_CPU_COUNT_CMD='printf 12' BELT_RUNNER_COUNT_CMD='printf 2'
[[ "$(source "$root_dir/belt-concurrency.sh"; belt_resolve_concurrency)" == 10 ]]
export BELT_RUNNER_COUNT_CMD='printf 0'; [[ "$(source "$root_dir/belt-concurrency.sh"; belt_resolve_concurrency)" == 12 ]]
export BELT_RUNNER_COUNT_CMD='printf 12'; [[ "$(source "$root_dir/belt-concurrency.sh"; belt_resolve_concurrency)" == 1 ]]
echo 'belt concurrency resolver tests passed'
