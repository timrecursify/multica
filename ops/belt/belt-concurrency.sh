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

belt_idle_runner_count() {
  local repository labels api_output
  if [[ -n "${BELT_IDLE_RUNNER_COUNT_CMD-}" ]]; then
    belt_run_count_command "$BELT_IDLE_RUNNER_COUNT_CMD"
    return
  fi
  repository="${BELT_CI_REPOSITORY:-timrecursify/multica}"
  labels="${BELT_REQUIRED_RUNNER_LABELS:-self-hosted,ci-build}"
  api_output=$(gh api "repos/${repository}/actions/runners?per_page=100") || return 1
  jq --arg required "$labels" '
    ($required | split(",") | map(select(length > 0))) as $wanted |
    [.runners[]? | select(.busy == false) | ((.labels // []) | map(.name)) as $have | select(all($wanted[]; . as $label | ($have | index($label)) != null))] | length
  ' <<<"$api_output" | belt_run_count_command 'cat'
}

belt_resolve_concurrency() {
  local cpus idle resolved repository labels legacy_busy
  cpus=$(belt_cpu_count) || { echo 'belt-concurrency: unable to determine CPU count' >&2; return 1; }
  if [[ -z "${BELT_IDLE_RUNNER_COUNT_CMD-}" && -n "${BELT_RUNNER_COUNT_CMD-}" ]]; then
    legacy_busy=$(belt_run_count_command "$BELT_RUNNER_COUNT_CMD") || return 1
    idle=$((cpus - legacy_busy)); (( idle < 1 )) && idle=1
    resolved="$idle"
  else
    idle=$(belt_idle_runner_count) || { echo 'belt-concurrency: unable to determine idle CI runner count' >&2; return 1; }
    resolved=$(( idle < cpus ? idle : cpus ))
  fi
  repository="${BELT_CI_REPOSITORY:-timrecursify/multica}"
  labels="${BELT_REQUIRED_RUNNER_LABELS:-self-hosted,ci-build}"
  printf 'belt-concurrency: cpus=%s idle_runners=%s repository=%s required_labels=%s cap=%s\n' "$cpus" "$idle" "$repository" "$labels" "$resolved" >&2
  printf '%s\n' "$resolved"
}
