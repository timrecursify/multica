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
if MULTICA_DAEMON_BIN="$fake/daemon" MULTICA_DAEMON_CWD="$daemon_cwd" CAPTURE_FILE="$capture" MULTICA_DAEMON_MAX_CONCURRENT_TASKS=bad "$root_dir/multica-daemon-wrapper.sh"; then exit 1; fi
if MULTICA_DAEMON_BIN="$fake/daemon" MULTICA_DAEMON_CWD="$daemon_cwd" CAPTURE_FILE="$capture" MULTICA_DAEMON_MAX_CONCURRENT_TASKS= "$root_dir/multica-daemon-wrapper.sh"; then exit 1; fi
if MULTICA_DAEMON_BIN="$fake/daemon" MULTICA_DAEMON_CWD=relative CAPTURE_FILE="$capture" "$root_dir/multica-daemon-wrapper.sh"; then exit 1; fi
if MULTICA_DAEMON_BIN="$fake/daemon" MULTICA_DAEMON_CWD="$fake/missing" CAPTURE_FILE="$capture" "$root_dir/multica-daemon-wrapper.sh"; then exit 1; fi
echo 'wrapper launch regression passed'
