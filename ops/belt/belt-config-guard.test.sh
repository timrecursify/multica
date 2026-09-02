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
reset_calls=0; advance_calls=0
fixture_reset_rc=0; fixture_reset_output=1
fixture_advance_rc=0
fixture_advance_output='{"success":true,"issue":{"status":"Spec"},"task_id":"scoper-task"}'
spec_refly_reset() { reset_calls=$((reset_calls + 1)); SPEC_REFLOW_RC=$fixture_reset_rc; SPEC_REFLOW_OUTPUT=$fixture_reset_output; }
spec_refly_advance() { advance_calls=$((advance_calls + 1)); SPEC_REFLOW_RC=$fixture_advance_rc; SPEC_REFLOW_OUTPUT=$fixture_advance_output; }
run_spec_refly_fixture() { fixed=(); unfixable=(); reset_calls=0; advance_calls=0; recover_stranded_spec_flight 1772; }
run_spec_refly_fixture
assert_eq '1' "$reset_calls" 'successful stranded-Spec recovery resets once'
assert_eq '1' "$advance_calls" 'successful stranded-Spec recovery advances after reset'
assert_eq '1' "${#fixed[@]}" 'successful stranded-Spec recovery is fixed'
fixture_reset_output=0
run_spec_refly_fixture
assert_eq '0' "$advance_calls" 'zero-row reset does not relay advance'
assert_eq '1' "${#unfixable[@]}" 'zero-row reset is non-successful'
fixture_reset_output=1; fixture_advance_rc=7; fixture_advance_output='relay unavailable token=not-for-output'
run_spec_refly_fixture
assert_eq '1' "$advance_calls" 'relay failure occurs after reset'
assert_eq '1' "${#unfixable[@]}" 'relay failure is non-successful'
fixture_advance_rc=0; fixture_advance_output='not-json'
run_spec_refly_fixture
assert_eq '1' "${#unfixable[@]}" 'malformed receipt is non-successful'
fixture_advance_output='{"success":true,"issue":{"status":"Spec"},"task_id":null}'
run_spec_refly_fixture
assert_eq '1' "${#unfixable[@]}" 'receipt without scoper task is non-successful'
echo 'belt config guard launch regression passed'
