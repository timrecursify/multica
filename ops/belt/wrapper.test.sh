#!/usr/bin/env bash
set -euo pipefail
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
fake="$(mktemp -d)"; trap 'rm -rf "$fake"' EXIT
cat >"$fake/daemon" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == 'daemon start --help' ]]; then
  if [[ "${HANG_HELP:-0}" == 1 ]]; then sleep 3; fi
  if [[ "${FAIL_HELP:-0}" == 1 ]]; then exit 17; fi
  if [[ "${DAEMON_SUPPORTS_WORKSPACES_FLAG:-1}" == 1 ]]; then
    printf '%s\n' '      --workspaces-root string Base directory for task workspaces'
  else
    printf '%s\n' '      --max-concurrent-tasks int Max tasks running in parallel'
  fi
  exit 0
fi
printf '%s\n' "$*" >"${CAPTURE_FILE:?}"
printf 'cap=%s root=%s daemon_root=%s workspaces=%s\n' "${MULTICA_DAEMON_MAX_CONCURRENT_TASKS:-}" "${MULTICA_DAEMON_WORKSPACES_ROOT:-}" "${MULTICA_WORKSPACES_ROOT:-}" "${DISCOVERED_WORKSPACES:-2}" >>"${CAPTURE_FILE}"
printf 'go_path=%s\n' "${PATH%%:*}" >>"${CAPTURE_FILE}"
printf 'cwd=%s\n' "$PWD" >>"${CAPTURE_FILE}"
if [[ "${HOLD_DAEMON:-0}" == 1 ]]; then sleep 3; fi
EOF
chmod +x "$fake/daemon"
daemon_cwd="$fake/daemon-root"
mkdir -p -- "$daemon_cwd"
capture="$fake/capture"
MULTICA_DAEMON_BIN="$fake/daemon" MULTICA_DAEMON_CWD="$daemon_cwd" CAPTURE_FILE="$capture" MULTICA_DAEMON_LOCK_FILE="$fake/lock" MULTICA_DAEMON_MAX_CONCURRENT_TASKS=2 MULTICA_DAEMON_WORKSPACES_ROOT="$fake/ws" "$root_dir/multica-daemon-wrapper.sh"
grep -q -- "--workspaces-root=$fake/ws" "$capture"
grep -q -- "--max-concurrent-tasks=2" "$capture"
grep -q 'cap=2 root=.* daemon_root=.* workspaces=2' "$capture"
grep -qx 'go_path=/usr/local/go/bin' "$capture"
grep -q "cwd=$daemon_cwd" "$capture"
env -u MULTICA_DAEMON_MAX_CONCURRENT_TASKS -u MULTICA_DAEMON_WORKSPACES_ROOT MULTICA_DAEMON_BIN="$fake/daemon" MULTICA_DAEMON_CWD="$daemon_cwd" CAPTURE_FILE="$capture" MULTICA_DAEMON_LOCK_FILE="$fake/lock" "$root_dir/multica-daemon-wrapper.sh"
grep -q "cap=32 root=/home/newadmin/multica-workspaces-gsp" "$capture"
grep -q -- "--max-concurrent-tasks=32" "$capture"
DAEMON_SUPPORTS_WORKSPACES_FLAG=0 MULTICA_DAEMON_BIN="$fake/daemon" MULTICA_DAEMON_CWD="$daemon_cwd" CAPTURE_FILE="$capture" MULTICA_DAEMON_LOCK_FILE="$fake/new.lock" MULTICA_DAEMON_MAX_CONCURRENT_TASKS=32 MULTICA_DAEMON_WORKSPACES_ROOT="$fake/new-workspaces" "$root_dir/multica-daemon-wrapper.sh"
grep -q '^daemon start --foreground --daemon-id=gsp-multica-worker --heartbeat-interval=30s --poll-interval=2s --max-concurrent-tasks=32$' "$capture"
grep -q "cap=32 root=$fake/new-workspaces daemon_root=$fake/new-workspaces workspaces=2" "$capture"
if grep -q -- '--workspaces-root' "$capture"; then
  echo 'flagless daemon unexpectedly received --workspaces-root' >&2
  exit 1
fi
HOLD_DAEMON=1 MULTICA_DAEMON_BIN="$fake/daemon" MULTICA_DAEMON_CWD="$daemon_cwd" CAPTURE_FILE="$capture" MULTICA_DAEMON_LOCK_FILE="$fake/lock" "$root_dir/multica-daemon-wrapper.sh" &
pid=$!; sleep 0.1
if MULTICA_DAEMON_BIN="$fake/daemon" MULTICA_DAEMON_CWD="$daemon_cwd" CAPTURE_FILE="$capture" MULTICA_DAEMON_LOCK_FILE="$fake/lock" "$root_dir/multica-daemon-wrapper.sh"; then exit 1; fi
wait "$pid"
assert_wrapper_rejects() {
  local label="$1" expected="$2" stderr="$fake/$1.stderr" status
  shift 2
  if env "$@" MULTICA_DAEMON_LOCK_FILE="$fake/$label.lock" "$root_dir/multica-daemon-wrapper.sh" 2>"$stderr"; then
    echo "$label unexpectedly succeeded" >&2
    return 1
  else
    status=$?
  fi
  [[ "$status" -eq 64 ]]
  [[ "$(<"$stderr")" == "$expected" ]]
}
assert_wrapper_rejects cap-bad \
  'multica-daemon-wrapper: MULTICA_DAEMON_MAX_CONCURRENT_TASKS must be a positive integer' \
  MULTICA_DAEMON_BIN="$fake/daemon" MULTICA_DAEMON_CWD="$daemon_cwd" CAPTURE_FILE="$capture" MULTICA_DAEMON_MAX_CONCURRENT_TASKS=bad
assert_wrapper_rejects cap-empty \
  'multica-daemon-wrapper: MULTICA_DAEMON_MAX_CONCURRENT_TASKS must be a positive integer' \
  MULTICA_DAEMON_BIN="$fake/daemon" MULTICA_DAEMON_CWD="$daemon_cwd" CAPTURE_FILE="$capture" MULTICA_DAEMON_MAX_CONCURRENT_TASKS=
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
