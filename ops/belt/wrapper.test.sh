#!/usr/bin/env bash
set -euo pipefail
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
fake="$(mktemp -d)"; trap 'rm -rf "$fake"' EXIT
export BELT_TEST_MODE=1
cat >"$fake/daemon" <<'EOF'
#!/bin/sh
if [ "$*" = 'daemon start --help' ]; then
  if [ "${HANG_HELP:-0}" = 1 ]; then sleep 3; fi
  if [ "${FAIL_HELP:-0}" = 1 ]; then exit 17; fi
  if [ "${DAEMON_SUPPORTS_WORKSPACES_FLAG:-1}" = 1 ]; then
    printf '%s\n' '      --workspaces-root string Base directory for task workspaces'
  else
    printf '%s\n' '      --max-concurrent-tasks int Max tasks running in parallel'
  fi
  exit 0
fi
if [ -n "${DAEMON_LAUNCH_MARKER:-}" ]; then
  : >"$DAEMON_LAUNCH_MARKER"
fi
printf '%s\n' "$*" >"${CAPTURE_FILE:?}"
printf 'cap=%s root=%s daemon_root=%s workspaces=%s\n' "${MULTICA_DAEMON_MAX_CONCURRENT_TASKS:-}" "${MULTICA_DAEMON_WORKSPACES_ROOT:-}" "${MULTICA_WORKSPACES_ROOT:-}" "${DISCOVERED_WORKSPACES:-2}" >>"${CAPTURE_FILE}"
printf 'go_path=%s\n' "${PATH%%:*}" >>"${CAPTURE_FILE}"
printf 'cwd=%s\n' "$PWD" >>"${CAPTURE_FILE}"
if [ "${HOLD_DAEMON:-0}" = 1 ]; then sleep 3; fi
EOF
chmod +x "$fake/daemon"
daemon_cwd="$fake/daemon-root"
mkdir -p -- "$daemon_cwd"
for workspace_root in "$fake/ws" "$fake/new-workspaces"; do
  mkdir -p -- "$workspace_root/da3c5c5c-a123-4567-b999-c3ed1820da00" \
    "$workspace_root/f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f"
done
capture="$fake/capture"
launch_marker="$fake/daemon-launch"
DAEMON_LAUNCH_MARKER="$launch_marker" BELT_CPU_COUNT_CMD='printf 12' BELT_IDLE_RUNNER_COUNT_CMD='printf 2' MULTICA_DAEMON_BIN="$fake/daemon" MULTICA_DAEMON_CWD="$daemon_cwd" CAPTURE_FILE="$capture" MULTICA_DAEMON_LOCK_FILE="$fake/lock" MULTICA_DAEMON_MAX_CONCURRENT_TASKS=2 MULTICA_DAEMON_WORKSPACES_ROOT="$fake/ws" "$root_dir/multica-daemon-wrapper.sh"
[[ -e "$launch_marker" ]]
grep -q -- "--workspaces-root=$fake/ws" "$capture"
grep -q -- "--max-concurrent-tasks=2" "$capture"
grep -q 'cap=2 root=.* daemon_root=.* workspaces=2' "$capture"
grep -qx 'go_path=/usr/local/go/bin' "$capture"
grep -q "cwd=$daemon_cwd" "$capture"
env -u MULTICA_DAEMON_MAX_CONCURRENT_TASKS BELT_CPU_COUNT_CMD='printf 12' BELT_IDLE_RUNNER_COUNT_CMD='printf 2' MULTICA_DAEMON_BIN="$fake/daemon" MULTICA_DAEMON_CWD="$daemon_cwd" MULTICA_DAEMON_WORKSPACES_ROOT="$fake/ws" CAPTURE_FILE="$capture" MULTICA_DAEMON_LOCK_FILE="$fake/empty.lock" "$root_dir/multica-daemon-wrapper.sh"
grep -q -- '--max-concurrent-tasks=2' "$capture"
DAEMON_SUPPORTS_WORKSPACES_FLAG=0 BELT_CPU_COUNT_CMD='printf 12' BELT_IDLE_RUNNER_COUNT_CMD='printf 12' MULTICA_DAEMON_BIN="$fake/daemon" MULTICA_DAEMON_CWD="$daemon_cwd" CAPTURE_FILE="$capture" MULTICA_DAEMON_LOCK_FILE="$fake/new.lock" MULTICA_DAEMON_MAX_CONCURRENT_TASKS=12 MULTICA_DAEMON_WORKSPACES_ROOT="$fake/new-workspaces" "$root_dir/multica-daemon-wrapper.sh"
grep -q '^daemon start --foreground --daemon-id=gsp-multica-worker --heartbeat-interval=30s --poll-interval=2s --max-concurrent-tasks=12$' "$capture"
grep -q "cap=12 root=$fake/new-workspaces daemon_root=$fake/new-workspaces workspaces=2" "$capture"
if grep -q -- '--workspaces-root' "$capture"; then
  echo 'flagless daemon unexpectedly received --workspaces-root' >&2
  exit 1
fi
HOLD_DAEMON=1 BELT_CPU_COUNT_CMD='printf 12' BELT_IDLE_RUNNER_COUNT_CMD='printf 2' MULTICA_DAEMON_MAX_CONCURRENT_TASKS=2 MULTICA_DAEMON_WORKSPACES_ROOT="$fake/ws" MULTICA_DAEMON_BIN="$fake/daemon" MULTICA_DAEMON_CWD="$daemon_cwd" CAPTURE_FILE="$capture" MULTICA_DAEMON_LOCK_FILE="$fake/lock" "$root_dir/multica-daemon-wrapper.sh" &
pid=$!; sleep 0.1
if BELT_CPU_COUNT_CMD='printf 12' BELT_IDLE_RUNNER_COUNT_CMD='printf 2' MULTICA_DAEMON_MAX_CONCURRENT_TASKS=2 MULTICA_DAEMON_WORKSPACES_ROOT="$fake/ws" MULTICA_DAEMON_BIN="$fake/daemon" MULTICA_DAEMON_CWD="$daemon_cwd" CAPTURE_FILE="$capture" MULTICA_DAEMON_LOCK_FILE="$fake/lock" "$root_dir/multica-daemon-wrapper.sh"; then exit 1; fi
wait "$pid"
assert_wrapper_rejects() {
  local label="$1" expected="$2" stderr="$fake/$1.stderr" status
  shift 2
  rm -f -- "$capture"
  if env BELT_CPU_COUNT_CMD='printf 12' BELT_IDLE_RUNNER_COUNT_CMD='printf 2' MULTICA_DAEMON_MAX_CONCURRENT_TASKS=2 MULTICA_DAEMON_WORKSPACES_ROOT="${MULTICA_DAEMON_WORKSPACES_ROOT-$fake/ws}" "$@" DAEMON_LAUNCH_MARKER="$launch_marker" MULTICA_DAEMON_LOCK_FILE="$fake/$label.lock" "$root_dir/multica-daemon-wrapper.sh" 2>"$stderr"; then
    echo "$label unexpectedly succeeded" >&2
    return 1
  else
    status=$?
  fi
  [[ "$status" -eq 64 ]]
  [[ "$(<"$stderr")" == "$expected" ]]
  [[ ! -e "$launch_marker" ]]
  [[ ! -e "$capture" ]]
}
rm -f -- "$launch_marker"
assert_wrapper_rejects cap-bad \
  'multica-daemon-wrapper: MULTICA_DAEMON_MAX_CONCURRENT_TASKS must be a non-negative integer' \
  MULTICA_DAEMON_BIN="$fake/daemon" MULTICA_DAEMON_CWD="$daemon_cwd" CAPTURE_FILE="$capture" MULTICA_DAEMON_MAX_CONCURRENT_TASKS=bad
assert_wrapper_rejects cap-high \
  'multica-daemon-wrapper: MULTICA_DAEMON_MAX_CONCURRENT_TASKS must not exceed CPU count (12)' \
  MULTICA_DAEMON_BIN="$fake/daemon" MULTICA_DAEMON_CWD="$daemon_cwd" CAPTURE_FILE="$capture" MULTICA_DAEMON_MAX_CONCURRENT_TASKS=13
assert_wrapper_rejects cap-empty \
  'multica-daemon-wrapper: MULTICA_DAEMON_MAX_CONCURRENT_TASKS must be a non-negative integer' \
  MULTICA_DAEMON_BIN="$fake/daemon" MULTICA_DAEMON_CWD="$daemon_cwd" CAPTURE_FILE="$capture" MULTICA_DAEMON_MAX_CONCURRENT_TASKS=
assert_wrapper_rejects root-relative \
  'multica-daemon-wrapper: workspace root must be an absolute path' \
  MULTICA_DAEMON_BIN="$fake/daemon" MULTICA_DAEMON_CWD="$daemon_cwd" CAPTURE_FILE="$capture" MULTICA_DAEMON_WORKSPACES_ROOT=relative
assert_wrapper_rejects root-empty \
  'multica-daemon-wrapper: workspace root must be an absolute path' \
  MULTICA_DAEMON_BIN="$fake/daemon" MULTICA_DAEMON_CWD="$daemon_cwd" CAPTURE_FILE="$capture" MULTICA_DAEMON_WORKSPACES_ROOT=
assert_wrapper_rejects cwd-relative \
  'multica-daemon-wrapper: MULTICA_DAEMON_CWD must be an existing absolute directory' \
  MULTICA_DAEMON_BIN="$fake/daemon" MULTICA_DAEMON_CWD=relative CAPTURE_FILE="$capture"
assert_wrapper_rejects cwd-missing \
  'multica-daemon-wrapper: MULTICA_DAEMON_CWD must be an existing absolute directory' \
  MULTICA_DAEMON_BIN="$fake/daemon" MULTICA_DAEMON_CWD="$fake/missing" CAPTURE_FILE="$capture"
rm -f -- "$capture"
assert_wrapper_rejects help-nonzero \
  'multica-daemon-wrapper: daemon start capability probe failed (exit 17)' \
  MULTICA_DAEMON_BIN="$fake/daemon" MULTICA_DAEMON_CWD="$daemon_cwd" CAPTURE_FILE="$capture" FAIL_HELP=1
[[ ! -e "$capture" ]]
start="$(date +%s)"
assert_wrapper_rejects help-timeout \
  'multica-daemon-wrapper: daemon start capability probe timed out' \
  MULTICA_DAEMON_BIN="$fake/daemon" MULTICA_DAEMON_CWD="$daemon_cwd" CAPTURE_FILE="$capture" HANG_HELP=1 MULTICA_DAEMON_HELP_TIMEOUT_SECONDS=1
[[ $(( $(date +%s) - start )) -lt 3 && ! -e "$capture" ]]
echo 'wrapper launch regression passed'
