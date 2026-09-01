#!/usr/bin/env bash
set -euo pipefail
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
fake="$(mktemp -d)"; trap 'rm -rf "$fake"' EXIT
cat >"$fake/daemon" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >"${CAPTURE_FILE:?}"
printf 'cap=%s root=%s\n' "${MULTICA_DAEMON_MAX_CONCURRENT_TASKS:-}" "${MULTICA_DAEMON_WORKSPACES_ROOT:-}" >>"${CAPTURE_FILE}"
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
grep -q 'cap=2 root=' "$capture"
grep -q "cwd=$daemon_cwd" "$capture"
env -u MULTICA_DAEMON_MAX_CONCURRENT_TASKS -u MULTICA_DAEMON_WORKSPACES_ROOT MULTICA_DAEMON_BIN="$fake/daemon" MULTICA_DAEMON_CWD="$daemon_cwd" CAPTURE_FILE="$capture" MULTICA_DAEMON_LOCK_FILE="$fake/lock" "$root_dir/multica-daemon-wrapper.sh"
grep -q "cap=10 root=/home/newadmin/multica-workspaces-gsp" "$capture"
grep -q -- "--max-concurrent-tasks=10" "$capture"
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
echo 'wrapper launch regression passed'
