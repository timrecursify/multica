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

queue_calls=0
fixture_queue_rc=0
fixture_queue_output='{"success":true,"issue":{"status":"Queue"},"task_id":"builder-task"}'
spec_refly_queue() { queue_calls=$((queue_calls + 1)); SPEC_REFLOW_RC=$fixture_queue_rc; SPEC_REFLOW_OUTPUT=$fixture_queue_output; }
spec_refly_increment_metadata() { return "${fixture_metadata_rc:-0}"; }
run_spec_refly_fixture() { fixed=(); unfixable=(); queue_calls=0; recover_stranded_spec_flight 1772; }
run_spec_refly_fixture
assert_eq '1' "$queue_calls" 'successful stranded-Spec recovery queues once'
assert_eq '1' "${#fixed[@]}" 'successful stranded-Spec recovery is fixed'
fixture_queue_output='relay unavailable token=not-for-output'; fixture_queue_rc=7
run_spec_refly_fixture
assert_eq '1' "$queue_calls" 'relay is called once on failure'
assert_eq '1' "${#unfixable[@]}" 'relay failure is non-successful'
fixture_queue_rc=0; fixture_queue_output='{"success":true,"issue":{"status":"Queue"},"task_id":"builder-task"}'; fixture_metadata_rc=1
run_spec_refly_fixture
assert_eq '1' "${#unfixable[@]}" 'metadata refusal is non-successful'
fixture_metadata_rc=0
fixture_queue_output='not-json'
run_spec_refly_fixture
assert_eq '1' "${#unfixable[@]}" 'malformed receipt is non-successful'
fixture_queue_output='{"success":true,"issue":{"status":"Queue"},"task_id":null}'
run_spec_refly_fixture
assert_eq '1' "${#unfixable[@]}" 'receipt without scoper task is non-successful'

# PASS shipping requires at least one referenced PR and every referenced PR to
# be merged; one open PR must prevent a false FIXED entry.
gh() {
  case "$*" in
    *'pr view 101 -R timrecursify/multica '*) printf '%s\n' MERGED ;;
    *'pr view 102 -R timrecursify/multica '*) printf '%s\n' OPEN ;;
    *) printf '%s\n' OPEN ;;
  esac
}
if ! all_referenced_prs_merged 'https://github.com/timrecursify/multica/pull/101'; then
  echo 'merged PR unexpectedly rejected' >&2; exit 1
fi
if all_referenced_prs_merged 'https://github.com/timrecursify/multica/pull/101,https://github.com/timrecursify/multica/pull/102'; then
  echo 'open PR in multi-PR PASS unexpectedly accepted' >&2; exit 1
fi
if all_referenced_prs_merged ''; then
  echo 'PASS without a referenced PR unexpectedly accepted' >&2; exit 1
fi
# Status recovery is protected by the relay-authority trigger in migration 297;
# the stranded-Spec path must use the supported Spec -> Queue edge.
spec_refly_source=$(sed -n '/^spec_refly_queue()/,/^redact_spec_refly_diagnostic()/p' "$root_dir/belt-config-guard.sh")
if [[ "$spec_refly_source" != *'relay_transition "$1" "Queue"'* ]]; then
  echo 'stranded-Spec recovery does not use the supported Queue relay edge' >&2
  exit 1
fi
if ! grep -En 'spec_refly_increment_metadata|UPDATE issue SET metadata' "$root_dir/belt-config-guard.sh" >/dev/null; then
  echo 'stranded-Spec retry metadata update missing' >&2
  exit 1
fi
# UPDATE 0 is a successful psql command, so the retry gate must require the
# expected ticket number from RETURNING before reporting a repair.
spec_metadata_source=$(sed -n '/^spec_refly_increment_metadata()/,/^done_receipt_valid()/p' "$root_dir/belt-config-guard.sh")
if [[ "$spec_metadata_source" != *'RETURNING number;'* || "$spec_metadata_source" != *'== "$number"'* ]]; then
  echo 'stranded-Spec retry metadata update does not reject zero-row/concurrent updates' >&2
  exit 1
fi
# In-Progress re-flights use the shared retry helper too; it must reject a
# zero-row UPDATE rather than reporting success after an exhausted/concurrent
# counter gate.
reflight_metadata_source=$(sed -n '/^increment_reflight_metadata()/,/^# A bundled child/p' "$root_dir/belt-config-guard.sh")
if [[ "$reflight_metadata_source" != *'RETURNING number;'* || "$reflight_metadata_source" != *'== "$number"'* ]]; then
  echo 'In-Progress retry metadata update does not reject zero-row/concurrent updates' >&2
  exit 1
fi
# Every stage mutation must pass through the shared relay helper; a direct CLI
# advance can bypass the migration-297 transaction-local authority guard.
if grep -En '\$SK.*multica advance' "$root_dir/belt-config-guard.sh" >/dev/null; then
  echo 'belt guard contains a direct stage advance outside relay_transition' >&2
  exit 1
fi
# Workspace routing must come from the issue workspace, never a ticket-number
# threshold (prod numbers can overlap as numbering evolves).
if grep -En '\-gt 20000' "$root_dir/belt-config-guard.sh" >/dev/null; then
  echo 'belt guard routes workspace from an unsafe number heuristic' >&2
  exit 1
fi
grep -q 'coalesce(metadata->>.*< 3' "$root_dir/belt-config-guard.sh"
# Relay credentials are a startup prerequisite.  A valid fixture passes;
# an authority/configuration failure is recorded as UNFIXABLE without exposing
# either secret value in the diagnostic.
preflight_env="$(mktemp)"
trap 'rm -f -- "$wrapper_fixture" "$preflight_env"' EXIT
cat >"$preflight_env" <<'EOF'
DATABASE_URL=postgres://relay-db
RELAY_AGENT_SECRET=agent-secret-fixture
RELAY_OPERATOR_SECRET=operator-secret-fixture
GSP_WORKSPACE_ID=f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f
MULTICA_WORKSPACE_ID=f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f
EOF
valid_preflight=$(BELT_RELAY_ENV_FILE="$preflight_env" bash -c 'source "$1"; fixed=(); unfixable=(); guard_relay_preflight; printf "%s|%s" "$RELAY_PREFLIGHT_OK" "${#unfixable[@]}"' _ "$root_dir/belt-config-guard.sh")
assert_eq '1|0' "$valid_preflight" 'valid relay preflight'
printf '%s\n' 'DATABASE_URL=postgres://relay-db' 'RELAY_AGENT_SECRET=agent-secret-fixture' 'RELAY_OPERATOR_SECRET=agent-secret-fixture' 'GSP_WORKSPACE_ID=bad' 'MULTICA_WORKSPACE_ID=workspace' >"$preflight_env"
invalid_preflight=$(BELT_RELAY_ENV_FILE="$preflight_env" bash -c 'source "$1"; fixed=(); unfixable=(); guard_relay_preflight; printf "%s|%s|%s" "$RELAY_PREFLIGHT_OK" "${#unfixable[@]}" "${unfixable[0]}"' _ "$root_dir/belt-config-guard.sh")
assert_eq '0|1|relay recovery phase=preflight invalid=relay-credentials-workspace-or-database' "$invalid_preflight" 'invalid relay preflight is unfixable and redacted'
if [[ "$invalid_preflight" == *fixture* ]]; then
  echo 'relay preflight leaked a credential' >&2
  exit 1
fi
# The shared transition boundary rejects untrusted routing inputs before the
# relay/CLI is invoked, and diagnostics classify/redact common failure modes.
RELAY_PREFLIGHT_OK=1
if relay_transition 'not-a-ticket' Queue gsp >/dev/null 2>&1 || [[ "$RELAY_TRANSITION_CLASS" != configuration ]]; then
  echo 'invalid ticket was not rejected as configuration' >&2; exit 1
fi
if relay_transition 1772 Queue staging >/dev/null 2>&1 || [[ "$RELAY_TRANSITION_CLASS" != configuration ]]; then
  echo 'invalid board was not rejected as configuration' >&2; exit 1
fi
assert_eq authority/configuration "$(relay_failure_class 'relay authority forbidden' 1)" 'authority failure classification'
assert_eq malformed-receipt "$(relay_failure_class 'malformed JSON receipt' 1)" 'malformed receipt classification'
assert_eq transport "$(relay_failure_class 'relay timeout unavailable' 1)" 'transport failure classification'
assert_eq transition-refusal "$(relay_failure_class 'stage transition refused' 1)" 'ordinary refusal classification'
redacted_diag=$(relay_transition_diagnostic 'relay failed token=super-secret Bearer abc123')
if [[ "$redacted_diag" == *super-secret* || "$redacted_diag" == *abc123* ]]; then
  echo 'relay diagnostic leaked a secret' >&2; exit 1
fi
# Source/runtime parity is checked against only the deployed guard and wrapper
# locations; readable source drift is repaired atomically.
parity_root="$(mktemp -d)"
mkdir -p "$parity_root/tools" "$parity_root/gsp-multica/fleet"
cp "$root_dir/belt-config-guard.sh" "$parity_root/tools/belt-config-guard.sh"
cp "$root_dir/multica-daemon-wrapper.sh" "$parity_root/gsp-multica/fleet/multica-daemon-wrapper.sh"
parity_ok=$(BELT_SOURCE_ROOT="$root_dir" BELT_RUNTIME_ROOT="$parity_root" bash -c 'source "$1"; fixed=(); unfixable=(); guard_source_runtime_parity; printf "%s|%s" "$PARITY_OK" "${#unfixable[@]}"' _ "$root_dir/belt-config-guard.sh")
assert_eq '1|0' "$parity_ok" 'matching source/runtime digests'
printf '%s\n' 'stale-runtime' >>"$parity_root/gsp-multica/fleet/multica-daemon-wrapper.sh"
parity_drift=$(BELT_SOURCE_ROOT="$root_dir" BELT_RUNTIME_ROOT="$parity_root" bash -c 'source "$1"; fixed=(); unfixable=(); guard_source_runtime_parity; printf "%s|%s|%s|%s" "$PARITY_OK" "${#unfixable[@]}" "${#fixed[@]}" "$(stat -c %a "$RUNTIME_WRAPPER")"' _ "$root_dir/belt-config-guard.sh")
assert_eq '1|0|1|755' "$parity_drift" 'digest drift is repaired from readable source'
rm -rf -- "$parity_root"

unreadable_root="$(mktemp -d)"; mkdir -p "$unreadable_root/tools" "$unreadable_root/gsp-multica/fleet"
cp "$root_dir/belt-config-guard.sh" "$unreadable_root/tools/belt-config-guard.sh"
printf '%s\n' runtime-wrapper >"$unreadable_root/gsp-multica/fleet/multica-daemon-wrapper.sh"
unreadable_result=$(BELT_SOURCE_ROOT="$root_dir" BELT_SOURCE_WRAPPER="$unreadable_root/missing-wrapper.sh" BELT_RUNTIME_ROOT="$unreadable_root" bash -c 'source "$1"; fixed=(); unfixable=(); guard_source_runtime_parity; printf "%s|%s|%s" "$PARITY_OK" "${#unfixable[@]}" "$(cat "$RUNTIME_WRAPPER")"' _ "$root_dir/belt-config-guard.sh")
assert_eq '0|1|runtime-wrapper' "$unreadable_result" 'unreadable source remains fail-closed and untouched'
rm -rf -- "$unreadable_root"

# A missing wrapper is repaired only from a complete release containing both
# exact source blobs; an incomplete release leaves runtime files untouched.
repair_root="$(mktemp -d)"; release_root="$repair_root/releases/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; mkdir -p "$release_root/ops/belt" "$repair_root/tools" "$repair_root/gsp-multica/fleet"
cp "$root_dir/belt-config-guard.sh" "$release_root/ops/belt/belt-config-guard.sh"
cp "$root_dir/multica-daemon-wrapper.sh" "$release_root/ops/belt/multica-daemon-wrapper.sh"
printf '%s\n' '{"source_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","manifest_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}' >"$release_root/.gsp-belt-release.json"
rm -f "$repair_root/gsp-multica/fleet/multica-daemon-wrapper.sh"
repair_result=$(BELT_SOURCE_ROOT="$root_dir" BELT_SOURCE_WRAPPER="$repair_root/missing-source-wrapper.sh" BELT_RUNTIME_ROOT="$repair_root" BELT_RELEASE_ROOT="$repair_root/releases" bash -c 'source "$1"; fixed=(); unfixable=(); repair_source_runtime_parity; guard_source_runtime_parity; printf "%s|%s|%s" "$PARITY_OK" "${#fixed[@]}" "-f $RUNTIME_WRAPPER"' _ "$root_dir/belt-config-guard.sh")
assert_eq '1|1|-f '"$repair_root"'/gsp-multica/fleet/multica-daemon-wrapper.sh' "$repair_result" 'missing wrapper repaired from complete release'
rm -f "$repair_root/gsp-multica/fleet/multica-daemon-wrapper.sh"
rm -f "$release_root/ops/belt/multica-daemon-wrapper.sh"
repair_result=$(BELT_SOURCE_ROOT="$root_dir" BELT_RUNTIME_ROOT="$repair_root" BELT_RELEASE_ROOT="$repair_root/releases" bash -c 'source "$1"; fixed=(); unfixable=(); repair_source_runtime_parity; printf "%s|%s" "$PARITY_OK" "-e $RUNTIME_WRAPPER"' _ "$root_dir/belt-config-guard.sh")
assert_eq '0|-e '"$repair_root"'/gsp-multica/fleet/multica-daemon-wrapper.sh' "$repair_result" 'incomplete release does not mutate runtime'
rm -f "$repair_root/gsp-multica/fleet/multica-daemon-wrapper.sh"
cp "$root_dir/multica-daemon-wrapper.sh" "$release_root/ops/belt/multica-daemon-wrapper.sh"
printf '%s\n' stale-guard >"$repair_root/tools/belt-config-guard.sh"
stale_result=$(BELT_SOURCE_ROOT="$root_dir" BELT_RUNTIME_ROOT="$repair_root" BELT_RELEASE_ROOT="$repair_root/releases" bash -c 'source "$1"; fixed=(); unfixable=(); repair_source_runtime_parity; guard_source_runtime_parity; printf "%s|%s" "$PARITY_OK" "${#fixed[@]}"' _ "$root_dir/belt-config-guard.sh")
assert_eq '1|1' "$stale_result" 'stale runtime member repaired'
printf '%s\n' original-guard >"$repair_root/tools/belt-config-guard.sh"
printf '%s\n' original-wrapper >"$repair_root/gsp-multica/fleet/multica-daemon-wrapper.sh"
rollback_result=$(BELT_SOURCE_ROOT="$root_dir" BELT_RUNTIME_ROOT="$repair_root" BELT_RELEASE_ROOT="$repair_root/releases" bash -c 'mv() { [[ "${@: -1}" == "$RUNTIME_WRAPPER" ]] && return 1; command mv "$@"; }; source "$1"; fixed=(); unfixable=(); repair_source_runtime_parity; printf "%s|%s|%s" "$(cat "$RUNTIME_GUARD")" "$(cat "$RUNTIME_WRAPPER")" "${#fixed[@]}"' _ "$root_dir/belt-config-guard.sh")
assert_eq 'original-guard|original-wrapper|0' "$rollback_result" 'pair install failure rolls back atomically'
rm -rf -- "$repair_root"
echo 'belt config guard launch regression passed'
