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
assert_eq '10|/home/newadmin/multica-workspaces-gsp' "$(BELT_CPU_COUNT_CMD='printf 12' BELT_RUNNER_COUNT_CMD='printf 2' env -u MULTICA_DAEMON_MAX_CONCURRENT_TASKS -u MULTICA_DAEMON_WORKSPACES_ROOT bash -c 'source "$1"; daemon_launch_config' _ "$root_dir/belt-config-guard.sh")" 'undeclared daemon launch config'
export MULTICA_DAEMON_MAX_CONCURRENT_TASKS=2
expected_cap=2
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
# Stranded-Spec relay receipts are accepted only when JSON is valid, the
# canonical status is Spec, and the relay selected a task identity.
assert_eq Spec "$(printf '%s' '{"current_status":"Spec","task_id":"task-1"}' | spec_receipt_status)" 'valid Spec receipt status'
assert_eq task-1 "$(printf '%s' '{"current_status":"Spec","task_id":"task-1"}' | spec_receipt_task_id)" 'valid Spec receipt task id'
if [[ "$(printf '%s' '{"current_status":"Queue","task_id":"task-1"}' | spec_receipt_status)" == Spec ]]; then
  echo 'wrong-status receipt unexpectedly accepted' >&2; exit 1
fi
if printf '%s' '{"current_status":"Spec"}' | spec_receipt_task_id >/dev/null; then
  echo 'missing-task receipt unexpectedly accepted' >&2; exit 1
fi
if printf '%s' 'not-json' | spec_receipt_status >/dev/null 2>&1; then
  echo 'malformed receipt unexpectedly accepted' >&2; exit 1
fi

reset_calls=0; advance_calls=0
fixture_reset_rc=0; fixture_reset_output='{"success":true,"issue":{"status":"Registered"}}'
fixture_advance_rc=0
fixture_advance_output='{"success":true,"issue":{"status":"Spec"},"task_id":"scoper-task"}'
spec_refly_reset() { reset_calls=$((reset_calls + 1)); SPEC_REFLOW_RC=$fixture_reset_rc; SPEC_REFLOW_OUTPUT=$fixture_reset_output; }
spec_refly_advance() { advance_calls=$((advance_calls + 1)); SPEC_REFLOW_RC=$fixture_advance_rc; SPEC_REFLOW_OUTPUT=$fixture_advance_output; }
spec_refly_increment_metadata() { return "${fixture_metadata_rc:-0}"; }
run_spec_refly_fixture() { fixed=(); unfixable=(); reset_calls=0; advance_calls=0; recover_stranded_spec_flight 1772; }
run_spec_refly_fixture
assert_eq '1' "$reset_calls" 'successful stranded-Spec recovery resets once'
assert_eq '1' "$advance_calls" 'successful stranded-Spec recovery advances after reset'
assert_eq '1' "${#fixed[@]}" 'successful stranded-Spec recovery is fixed'
fixture_reset_output='{"success":true,"issue":{"status":"Registered"}}'
run_spec_refly_fixture
assert_eq '1' "$advance_calls" 'successful reset relays advance'
assert_eq '0' "${#unfixable[@]}" 'valid reset receipt is successful'
fixture_reset_output='relay unavailable token=not-for-output'; fixture_reset_rc=7; fixture_advance_rc=7; fixture_advance_output='relay unavailable token=not-for-output'
run_spec_refly_fixture
assert_eq '0' "$advance_calls" 'reset relay failure stops before advance'
assert_eq '1' "${#unfixable[@]}" 'relay failure is non-successful'
fixture_reset_rc=0; fixture_reset_output='{"success":true,"issue":{"status":"Registered"}}'; fixture_metadata_rc=1; fixture_advance_rc=0
run_spec_refly_fixture
assert_eq '0' "$advance_calls" 'metadata refusal stops before Spec advance'
assert_eq '1' "${#unfixable[@]}" 'metadata refusal is non-successful'
fixture_metadata_rc=0
fixture_advance_rc=0; fixture_advance_output='not-json'
run_spec_refly_fixture
assert_eq '1' "${#unfixable[@]}" 'malformed receipt is non-successful'
fixture_advance_output='{"success":true,"issue":{"status":"Spec"},"task_id":null}'
run_spec_refly_fixture
assert_eq '1' "${#unfixable[@]}" 'receipt without scoper task is non-successful'
# Status recovery is protected by the relay-authority trigger in migration 297;
# reset must use the shared relay entry point and metadata must remain guarded.
spec_refly_source=$(sed -n '/^spec_refly_reset()/,/^spec_refly_advance()/p' "$root_dir/belt-config-guard.sh")
if [[ "$spec_refly_source" != *'relay_transition "$number" "Registered" "$board"'* ]]; then
  echo 'stranded-Spec reset does not use relay authority' >&2
  exit 1
fi
if ! rg -n 'spec_refly_increment_metadata|UPDATE issue SET metadata' "$root_dir/belt-config-guard.sh" >/dev/null; then
  echo 'stranded-Spec retry metadata update missing' >&2
  exit 1
fi
# Every stage mutation must pass through the shared relay helper; a direct CLI
# advance can bypass the migration-297 transaction-local authority guard.
if rg -n '\$SK.*multica advance' "$root_dir/belt-config-guard.sh" >/dev/null; then
  echo 'belt guard contains a direct stage advance outside relay_transition' >&2
  exit 1
fi
echo 'belt config guard launch regression passed'
