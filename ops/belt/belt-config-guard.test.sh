#!/usr/bin/env bash
# shellcheck disable=SC1091,SC2016 # The fixture intentionally sources a dynamic path and writes a literal flag.
set -euo pipefail
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
assert_eq() {
  local expected="$1" actual="$2" reason="$3"
  if [[ "$actual" != "$expected" ]]; then
    printf 'belt config guard test: %s (got %q; want %q)\n' "$reason" "$actual" "$expected" >&2
    return 1
  fi
}
assert_invalid() {
  if validate_daemon_launch_config; then
    printf '%s\n' 'belt config guard test: invalid daemon launch config unexpectedly accepted' >&2
    return 1
  fi
}
assert_valid() {
  if ! validate_daemon_launch_config; then
    printf '%s\n' 'belt config guard test: valid daemon launch config unexpectedly rejected' >&2
    return 1
  fi
}
unset MULTICA_DAEMON_MAX_CONCURRENT_TASKS MULTICA_DAEMON_WORKSPACES_ROOT
source "$root_dir/belt-config-guard.sh"
IFS='|' read -r expected_cap expected_root < <(daemon_launch_config)
assert_eq '2|/tmp/gsp-workspaces' "$(MULTICA_DAEMON_MAX_CONCURRENT_TASKS=2 MULTICA_DAEMON_WORKSPACES_ROOT=/tmp/gsp-workspaces daemon_launch_config)" 'configured daemon launch config'
MULTICA_DAEMON_MAX_CONCURRENT_TASKS=2 MULTICA_DAEMON_WORKSPACES_ROOT=/tmp/gsp-workspaces assert_valid
assert_eq "${expected_cap}|${expected_root}" "$(env -u MULTICA_DAEMON_MAX_CONCURRENT_TASKS -u MULTICA_DAEMON_WORKSPACES_ROOT bash -c 'source "$1"; daemon_launch_config' _ "$root_dir/belt-config-guard.sh")" 'default daemon launch config'
MULTICA_DAEMON_MAX_CONCURRENT_TASKS=bad MULTICA_DAEMON_WORKSPACES_ROOT=/tmp/gsp-workspaces assert_invalid
MULTICA_DAEMON_MAX_CONCURRENT_TASKS='' MULTICA_DAEMON_WORKSPACES_ROOT=/tmp/gsp-workspaces assert_invalid
MULTICA_DAEMON_MAX_CONCURRENT_TASKS=2 MULTICA_DAEMON_WORKSPACES_ROOT=relative assert_invalid
MULTICA_DAEMON_MAX_CONCURRENT_TASKS=2 MULTICA_DAEMON_WORKSPACES_ROOT='' assert_invalid
assert_eq missing "$(tower_concurrency_state 'multica-daemon/server daemon start')" 'missing Tower concurrency flag'
assert_eq correct "$(tower_concurrency_state "multica-daemon/server daemon start --max-concurrent-tasks=${expected_cap}")" 'configured Tower concurrency flag'
assert_eq mismatched "$(tower_concurrency_state "multica-daemon/server daemon start --max-concurrent-tasks=$((expected_cap + 1))")" 'mismatched Tower concurrency flag'
for expected in "${RELAY_CAP_EXPECTATIONS[@]}"; do
  IFS='|' read -r app expected_stage expected_lifetime <<<"$expected"
  if ! relay_caps_match "$expected_stage" "$expected_lifetime" "$expected_stage" "$expected_lifetime"; then
    printf 'belt config guard test: expected relay caps rejected for %s\n' "$app" >&2
    exit 1
  fi
  if relay_caps_match "$expected_stage" "$expected_lifetime" "$((expected_stage + 1))" "$expected_lifetime"; then
    printf 'belt config guard test: stage-cycle relay cap drift accepted for %s\n' "$app" >&2
    exit 1
  fi
  if relay_caps_match "$expected_stage" "$expected_lifetime" "$expected_stage" "$((expected_lifetime + 1))"; then
    printf 'belt config guard test: lifetime-task relay cap drift accepted for %s\n' "$app" >&2
    exit 1
  fi
done
wrapper_fixture="$(mktemp)"
trap 'rm -f -- "$wrapper_fixture"' EXIT
printf '%s\n' '  --max-concurrent-tasks="$cap_raw"' >"$wrapper_fixture"
if ! wrapper_has_explicit_concurrency_flag "$wrapper_fixture"; then
  printf '%s\n' 'belt config guard test: env-resolved daemon concurrency flag unexpectedly rejected' >&2
  exit 1
fi
printf '%s\n' "  --max-concurrent-tasks=${expected_cap}" >"$wrapper_fixture"
if wrapper_has_explicit_concurrency_flag "$wrapper_fixture"; then
  echo 'hard-coded daemon concurrency flag unexpectedly accepted' >&2
  exit 1
fi
echo 'belt config guard launch regression passed'
