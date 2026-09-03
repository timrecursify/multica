#!/usr/bin/env bash
# shellcheck disable=SC2016
set -u

belt_run_count_command() {
  local command="$1" output
  output=$(bash -c "$command") || return 1
  [[ "$output" =~ ^[[:space:]]*[0-9]+[[:space:]]*$ ]] || return 1
  printf '%s\n' "$output" | tr -d '[:space:]'
}

belt_cpu_count() {
  belt_run_count_command "${BELT_CPU_COUNT_CMD:-nproc}"
}

belt_runner_count() {
  belt_run_count_command "${BELT_RUNNER_COUNT_CMD:-ps -eo comm= | awk '\$1 == \"Runner.Worker\" { n++ } END { print n+0 }'}"
}

belt_resolve_concurrency() {
  local cpus runners resolved
  cpus=$(belt_cpu_count) || { echo 'belt-concurrency: unable to determine CPU count' >&2; return 1; }
  runners=$(belt_runner_count) || { echo 'belt-concurrency: unable to determine Runner.Worker count' >&2; return 1; }
  resolved=$((cpus - runners))
  (( resolved < 1 )) && resolved=1
  printf '%s\n' "$resolved"
}
