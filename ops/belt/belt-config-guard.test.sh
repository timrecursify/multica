#!/usr/bin/env bash
set -euo pipefail
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$root_dir/belt-config-guard.sh"
assert_invalid() { if validate_daemon_launch_config; then return 1; fi; }
[[ "$(MULTICA_DAEMON_MAX_CONCURRENT_TASKS=2 MULTICA_DAEMON_WORKSPACES_ROOT=/tmp/gsp-workspaces daemon_launch_config)" == '2|/tmp/gsp-workspaces' ]]
MULTICA_DAEMON_MAX_CONCURRENT_TASKS=2 MULTICA_DAEMON_WORKSPACES_ROOT=/tmp/gsp-workspaces validate_daemon_launch_config
[[ "$(env -u MULTICA_DAEMON_MAX_CONCURRENT_TASKS -u MULTICA_DAEMON_WORKSPACES_ROOT bash -c 'source "$1"; daemon_launch_config' _ "$root_dir/belt-config-guard.sh")" == '32|/home/newadmin/multica-workspaces-gsp' ]]
MULTICA_DAEMON_MAX_CONCURRENT_TASKS=bad MULTICA_DAEMON_WORKSPACES_ROOT=/tmp/gsp-workspaces assert_invalid
MULTICA_DAEMON_MAX_CONCURRENT_TASKS= MULTICA_DAEMON_WORKSPACES_ROOT=/tmp/gsp-workspaces assert_invalid
MULTICA_DAEMON_MAX_CONCURRENT_TASKS=2 MULTICA_DAEMON_WORKSPACES_ROOT=relative assert_invalid
MULTICA_DAEMON_MAX_CONCURRENT_TASKS=2 MULTICA_DAEMON_WORKSPACES_ROOT= assert_invalid
[[ "$(tower_concurrency_state 'multica-daemon/server daemon start')" == missing ]]
[[ "$(tower_concurrency_state 'multica-daemon/server daemon start --max-concurrent-tasks=10')" == correct ]]
[[ "$(tower_concurrency_state 'multica-daemon/server daemon start --max-concurrent-tasks=8')" == mismatched ]]
[[ "$(tower_concurrency_state 'multica-daemon/server daemon start --max-concurrent-tasks=100')" == mismatched ]]
wrapper_fixture="$(mktemp)"
trap 'rm -f -- "$wrapper_fixture"' EXIT
printf '%s\n' '  --max-concurrent-tasks="$cap_raw"' >"$wrapper_fixture"
wrapper_has_explicit_concurrency_flag "$wrapper_fixture"
printf '%s\n' '  --max-concurrent-tasks=32' >"$wrapper_fixture"
if wrapper_has_explicit_concurrency_flag "$wrapper_fixture"; then
  echo 'hard-coded daemon concurrency flag unexpectedly accepted' >&2
  exit 1
fi
echo 'belt config guard launch regression passed'
