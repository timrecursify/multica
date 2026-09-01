#!/usr/bin/env bash
# Hermetic PPP installer tests. No systemd manager, production path, network,
# profile token, or user-installed agent is accessed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
SHA=0123456789abcdef0123456789abcdef01234567
RELEASE="$WORK/releases/$SHA"
mkdir -p "$RELEASE/ops/ppp/systemd" "$WORK/home/.multica/profiles/ppp-prod-codex" "$WORK/bin"
cp "$ROOT/multica-daemon-ppp.sh" "$RELEASE/ops/ppp/"
cp "$ROOT/systemd/multica-daemon-ppp.service" "$RELEASE/ops/ppp/systemd/"
printf '#!/usr/bin/env bash\nsleep 30\n' >"$RELEASE/multica"; chmod 0755 "$RELEASE/multica"
printf '#!/usr/bin/env bash\nexit 0\n' >"$WORK/bin/codex"; chmod 0755 "$WORK/bin/codex"
printf '{"token":"test-token"}\n' >"$WORK/home/.multica/profiles/ppp-prod-codex/config.json"
chmod 0600 "$WORK/home/.multica/profiles/ppp-prod-codex/config.json"
cat >"$WORK/systemctl" <<'EOF'
#!/usr/bin/env bash
[[ "${1:-}" == --user ]] && shift
case "${1:-}" in
  is-active) exit "${PPP_TEST_ACTIVE:-1}" ;;
  is-enabled) exit 0 ;;
  enable) [[ "${PPP_TEST_ENABLE_FAIL:-0}" == 1 ]] && exit 42 || exit 0 ;;
  stop) printf stop >"${PPP_TEST_STOP_FILE:?}"; exit 0 ;;
  disable|daemon-reload) exit 0 ;;
  *) exit 0 ;;
esac
EOF
chmod 0755 "$WORK/systemctl"

common_env() {
  unset PPP_TEST_ENABLE_FAIL PPP_TEST_ACTIVE
  rm -f "$WORK/home/.config/multica/ppp-daemon.env"
  if [[ ! -x "$WORK/bin/codex" ]]; then printf '#!/usr/bin/env bash\nexit 0\n' >"$WORK/bin/codex"; chmod 0755 "$WORK/bin/codex"; fi
  export HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/home/.config"
  export PATH="$WORK/bin:/usr/bin:/bin" MULTICA_RELEASE_DIR="$RELEASE"
  export MULTICA_DAEMON_BIN="$RELEASE/multica" MULTICA_CODEX_PATH="$WORK/bin/codex"
  export MULTICA_SERVER_URL="https://multica.ai" MULTICA_WORKSPACES_ROOT="$WORK/workspaces"
  export MULTICA_SYSTEMCTL="$WORK/systemctl" MULTICA_DAEMON_BACKUP_DIR="$WORK/backups"
  export MULTICA_DAEMON_WRAPPER_DEST="$WORK/home/bin/multica-daemon-ppp.sh"
  export MULTICA_DAEMON_ENV_FILE="$WORK/home/.config/multica/ppp-daemon.env"
  export PPP_TEST_STOP_FILE="$WORK/stop"
}

test_missing_prerequisite_fails_closed() {
  common_env; rm "$WORK/bin/codex"
  if bash "$ROOT/install-multica-daemon-ppp.sh" >"$WORK/out" 2>"$WORK/err"; then return 1; fi
  grep -Fq 'Codex executable is missing' "$WORK/err"
  [[ ! -e "$WORK/home/bin/multica-daemon-ppp.sh" ]]
}

test_placeholder_environment_is_rejected() {
  common_env
  mkdir -p "$(dirname "$MULTICA_DAEMON_ENV_FILE")"
  printf 'MULTICA_SERVER_URL=<PPP_MULTICA_SERVER_URL>\n' >"$MULTICA_DAEMON_ENV_FILE"
  if bash "$ROOT/install-multica-daemon-ppp.sh" >/dev/null 2>"$WORK/err"; then return 1; fi
  grep -Fq 'refusing placeholder environment file' "$WORK/err"
}

test_install_rollback_restores_files() {
  common_env
  mkdir -p "$WORK/home/bin" "$WORK/home/.config/systemd/user"
  printf old-wrapper >"$WORK/home/bin/multica-daemon-ppp.sh"
  printf old-unit >"$WORK/home/.config/systemd/user/multica-daemon-ppp.service"
  export PPP_TEST_ENABLE_FAIL=1
  if bash "$ROOT/install-multica-daemon-ppp.sh" >/dev/null 2>"$WORK/err"; then return 1; fi
  [[ "$(<"$WORK/home/bin/multica-daemon-ppp.sh")" == old-wrapper ]]
  [[ "$(<"$WORK/home/.config/systemd/user/multica-daemon-ppp.service")" == old-unit ]]
}

test_active_uninstall_refuses_without_confirmation() {
  common_env
  mkdir -p "$WORK/home/bin" "$WORK/home/.config/systemd/user"
  printf installed >"$WORK/home/bin/multica-daemon-ppp.sh"
  export PPP_TEST_ACTIVE=0
  if bash "$ROOT/install-multica-daemon-ppp.sh" --uninstall >"$WORK/out" 2>"$WORK/err"; then return 1; fi
  grep -Fq 'unit is active; rerun with --confirm-stop' "$WORK/err"
  [[ -e "$WORK/home/bin/multica-daemon-ppp.sh" ]]
  [[ ! -e "$WORK/stop" ]]
}

test_success_and_lock() {
  common_env
  bash "$ROOT/install-multica-daemon-ppp.sh" >/dev/null
  grep -Fq 'MULTICA_DAEMON_BIN=' "$WORK/home/.config/multica/ppp-daemon.env"
  grep -Fq 'MULTICA_CODEX_PATH=' "$WORK/home/.config/multica/ppp-daemon.env"
  export MULTICA_DAEMON_LOCK_FILE="$WORK/lock"; export MULTICA_WORKSPACES_ROOT="$WORK/workspaces"
  export FAKE_ARGS="$WORK/args"
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "%%*" >"$FAKE_ARGS"; sleep 5\n' >"$WORK/fake-daemon"; chmod 0755 "$WORK/fake-daemon"
  export MULTICA_DAEMON_BIN="$WORK/fake-daemon"
  "$ROOT/multica-daemon-ppp.sh" & pid=$!
  for _ in 1 2 3 4 5; do [[ -s "$FAKE_ARGS" ]] && break; sleep 0.1; done
  if "$ROOT/multica-daemon-ppp.sh" 2>"$WORK/second.err"; then kill "$pid"; return 1; fi
  kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true
  grep -Fq 'duplicate instance' "$WORK/second.err"
}

test_missing_prerequisite_fails_closed
test_placeholder_environment_is_rejected
test_install_rollback_restores_files
test_active_uninstall_refuses_without_confirmation
test_success_and_lock
printf 'PASS: PPP preflight, placeholder rejection, rollback, active-uninstall refusal, and lock\n'
