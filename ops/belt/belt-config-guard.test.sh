#!/usr/bin/env bash
set -euo pipefail
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$root_dir/belt-config-guard.sh"
assert_invalid() { if validate_daemon_launch_config; then return 1; fi; }
[[ "$(MULTICA_DAEMON_MAX_CONCURRENT_TASKS=2 MULTICA_DAEMON_WORKSPACES_ROOT=/tmp/gsp-workspaces daemon_launch_config)" == '2|/tmp/gsp-workspaces' ]]
MULTICA_DAEMON_MAX_CONCURRENT_TASKS=2 MULTICA_DAEMON_WORKSPACES_ROOT=/tmp/gsp-workspaces validate_daemon_launch_config
[[ "$(env -u MULTICA_DAEMON_MAX_CONCURRENT_TASKS -u MULTICA_DAEMON_WORKSPACES_ROOT bash -c 'source "$1"; daemon_launch_config' _ "$root_dir/belt-config-guard.sh")" == '10|/home/newadmin/multica-workspaces-gsp' ]]
MULTICA_DAEMON_MAX_CONCURRENT_TASKS=bad MULTICA_DAEMON_WORKSPACES_ROOT=/tmp/gsp-workspaces assert_invalid
MULTICA_DAEMON_MAX_CONCURRENT_TASKS= MULTICA_DAEMON_WORKSPACES_ROOT=/tmp/gsp-workspaces assert_invalid
MULTICA_DAEMON_MAX_CONCURRENT_TASKS=2 MULTICA_DAEMON_WORKSPACES_ROOT=relative assert_invalid
MULTICA_DAEMON_MAX_CONCURRENT_TASKS=2 MULTICA_DAEMON_WORKSPACES_ROOT= assert_invalid
echo 'belt config guard launch regression passed'
