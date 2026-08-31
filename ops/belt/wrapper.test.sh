#!/usr/bin/env bash
set -euo pipefail
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
fake="$(mktemp -d)"; trap 'rm -rf "$fake"' EXIT
cat >"$fake/daemon" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >"${CAPTURE_FILE:?}"
printf 'cap=%s root=%s\n' "${MULTICA_DAEMON_MAX_CONCURRENT_TASKS:-}" "${MULTICA_DAEMON_WORKSPACES_ROOT:-}" >>"${CAPTURE_FILE}"
EOF
chmod +x "$fake/daemon"
capture="$fake/capture"
MULTICA_DAEMON_BIN="$fake/daemon" CAPTURE_FILE="$capture" MULTICA_DAEMON_MAX_CONCURRENT_TASKS=2 MULTICA_DAEMON_WORKSPACES_ROOT="$fake/ws" "$root_dir/multica-daemon-wrapper.sh"
grep -q -- "--workspaces-root=$fake/ws" "$capture"
grep -q 'cap=2 root=' "$capture"
env -u MULTICA_DAEMON_MAX_CONCURRENT_TASKS -u MULTICA_DAEMON_WORKSPACES_ROOT MULTICA_DAEMON_BIN="$fake/daemon" CAPTURE_FILE="$capture" "$root_dir/multica-daemon-wrapper.sh"
grep -q 'cap=20 root=/home/newadmin/multica-workspaces-gsp' "$capture"
if MULTICA_DAEMON_BIN="$fake/daemon" CAPTURE_FILE="$capture" MULTICA_DAEMON_MAX_CONCURRENT_TASKS=bad "$root_dir/multica-daemon-wrapper.sh"; then exit 1; fi
if MULTICA_DAEMON_BIN="$fake/daemon" CAPTURE_FILE="$capture" MULTICA_DAEMON_MAX_CONCURRENT_TASKS= "$root_dir/multica-daemon-wrapper.sh"; then exit 1; fi
if MULTICA_DAEMON_BIN="$fake/daemon" CAPTURE_FILE="$capture" MULTICA_DAEMON_WORKSPACES_ROOT=relative "$root_dir/multica-daemon-wrapper.sh"; then exit 1; fi
echo 'wrapper launch regression passed'
