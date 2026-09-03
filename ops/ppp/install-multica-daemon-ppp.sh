#!/usr/bin/env bash
# Install, verify, or remove the PPP user unit. Installation never starts the
# daemon; systemd remains the only process supervisor.
set -Eeo pipefail

PROFILE="ppp-prod-codex"
UNIT="multica-daemon-ppp.service"
HOME_DIR="${HOME:?HOME must be set}"
USER_DIR="${XDG_CONFIG_HOME:-$HOME_DIR/.config}/systemd/user"
UNIT_DST="$USER_DIR/$UNIT"
WRAPPER_DST="${MULTICA_DAEMON_WRAPPER_DEST:-$HOME_DIR/bin/multica-daemon-ppp.sh}"
ENV_FILE="${MULTICA_DAEMON_ENV_FILE:-$HOME_DIR/.config/multica/ppp-daemon.env}"
BACKUP_ROOT="${MULTICA_DAEMON_BACKUP_DIR:-$HOME_DIR/.local/state/multica/ppp-daemon-backups}"
SYSTEMCTL="${MULTICA_SYSTEMCTL:-systemctl}"
RELEASE_DIR="${MULTICA_RELEASE_DIR:-}"
DAEMON_BIN="${MULTICA_DAEMON_BIN:-}"
WORKSPACES_ROOT="${MULTICA_WORKSPACES_ROOT-}"
CODEX_PATH="${MULTICA_CODEX_PATH:-}"
SERVER_URL="${MULTICA_SERVER_URL:-}"
HEALTH_PORT="${MULTICA_DAEMON_HEALTH_PORT:-19909}"

mode=install
confirm_stop=0
dry_run=0
for arg in "$@"; do
  case "$arg" in
    --check) mode=check ;;
    --uninstall) mode=uninstall ;;
    --confirm-stop) confirm_stop=1 ;;
    --dry-run) dry_run=1 ;;
    *) echo "usage: $0 [--check|--uninstall [--confirm-stop]] [--dry-run]" >&2; exit 64 ;;
  esac
done

fail() { printf 'PPP daemon installer: %s\n' "$*" >&2; exit 78; }
run() {
  if ((dry_run)); then printf 'would run: %s\n' "$*"; else "$@"; fi
}
require_abs() { [[ "$1" = /* ]] || fail "$2 must be an absolute path"; }

canonical_path() {
  command -v realpath >/dev/null 2>&1 || fail "realpath is required for path containment checks"
  realpath -e -- "$1" 2>/dev/null || fail "$2 does not resolve to an existing path"
}

validate_release() {
  require_abs "$RELEASE_DIR" MULTICA_RELEASE_DIR
  [[ -d "$RELEASE_DIR" && ! -L "$RELEASE_DIR" ]] || fail "MULTICA_RELEASE_DIR is not a real directory"
  RELEASE_CANONICAL="$(canonical_path "$RELEASE_DIR" MULTICA_RELEASE_DIR)"
  [[ "$RELEASE_CANONICAL" == "$RELEASE_DIR" ]] || fail "MULTICA_RELEASE_DIR must be a canonical path"
  local name="${RELEASE_CANONICAL##*/}"
  [[ "$name" =~ ^[0-9a-f]{40}$ ]] || fail "MULTICA_RELEASE_DIR must be a SHA-named immutable release"
}

validate_binary() {
  [[ -n "$DAEMON_BIN" ]] || DAEMON_BIN="$RELEASE_DIR/multica"
  require_abs "$DAEMON_BIN" MULTICA_DAEMON_BIN
  [[ -f "$DAEMON_BIN" && -x "$DAEMON_BIN" && ! -L "$DAEMON_BIN" ]] || fail "daemon binary is not an executable regular file"
  local binary_canonical; binary_canonical="$(canonical_path "$DAEMON_BIN" MULTICA_DAEMON_BIN)"
  [[ "$binary_canonical" == "$RELEASE_CANONICAL/"* ]] || fail "daemon binary must come from MULTICA_RELEASE_DIR"
  [[ "$binary_canonical" == "$DAEMON_BIN" ]] || fail "MULTICA_DAEMON_BIN must be a canonical path"
}

validate_release_file() {
  local path="$1" label="$2"
  [[ -f "$path" && ! -L "$path" ]] || fail "$label is not a regular release file"
  local canonical; canonical="$(canonical_path "$path" "$label")"
  [[ "$canonical" == "$RELEASE_CANONICAL/"* ]] || fail "$label must come from MULTICA_RELEASE_DIR"
  [[ "$canonical" == "$path" ]] || fail "$label must use a canonical path"
}

discover_codex() {
  if [[ -z "$CODEX_PATH" ]]; then CODEX_PATH="$(command -v codex 2>/dev/null || true)"; fi
  require_abs "$CODEX_PATH" MULTICA_CODEX_PATH
  [[ -f "$CODEX_PATH" && -x "$CODEX_PATH" ]] || fail "Codex executable is missing or not executable"
}

validate_port() {
  [[ "$HEALTH_PORT" =~ ^[0-9]+$ && "$HEALTH_PORT" == 19909 ]] || fail "health port must be 19909 for $PROFILE"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$HEALTH_PORT" <<'PY' || fail "health port $HEALTH_PORT is already in use"
import socket, sys
s = socket.socket()
try:
    s.bind(("127.0.0.1", int(sys.argv[1])))
except OSError:
    raise SystemExit(1)
finally:
    s.close()
PY
  elif command -v ss >/dev/null 2>&1; then
    ! ss -H -ltn "sport = :$HEALTH_PORT" 2>/dev/null | grep -q . || fail "health port $HEALTH_PORT is already in use"
  else
    fail "preflight needs python3 or ss to verify health port $HEALTH_PORT"
  fi
}

profile_config() { printf '%s/.multica/profiles/%s/config.json' "$HOME_DIR" "$PROFILE"; }
validate_profile() {
  local cfg; cfg="$(profile_config)"
  [[ -r "$cfg" ]] || fail "profile config is missing: $PROFILE"
  local mode_bits; mode_bits="$(stat -c '%a' "$cfg" 2>/dev/null || stat -f '%Lp' "$cfg" 2>/dev/null || true)"
  [[ "$mode_bits" =~ ^[0-7]+$ && $((8#$mode_bits & 077)) == 0 ]] || fail "profile config permissions are too broad"
  grep -Eq '"token"[[:space:]]*:[[:space:]]*"[^"[:space:]][^"]*"' "$cfg" || fail "profile config has no login token"
}

read_env() {
  [[ -r "$ENV_FILE" ]] || return 1
  grep -q '<[^>]*>' "$ENV_FILE" && fail "refusing placeholder environment file"
  SERVER_URL="${SERVER_URL:-$(sed -n 's/^MULTICA_SERVER_URL=//p' "$ENV_FILE" | head -n1)}"
  WORKSPACES_ROOT="${WORKSPACES_ROOT:-$(sed -n 's/^MULTICA_WORKSPACES_ROOT=//p' "$ENV_FILE" | head -n1)}"
  CODEX_PATH="${MULTICA_CODEX_PATH:-$(sed -n 's/^MULTICA_CODEX_PATH=//p' "$ENV_FILE" | head -n1)}"
}

validate_env_values() {
  [[ -n "$SERVER_URL" && "$SERVER_URL" != *'<'* && "$SERVER_URL" != *'>'* && "$SERVER_URL" =~ ^(ws|wss|http|https)://[^[:space:]]+$ ]] || fail "MULTICA_SERVER_URL is missing or invalid"
  require_abs "$WORKSPACES_ROOT" MULTICA_WORKSPACES_ROOT
  require_abs "$CODEX_PATH" MULTICA_CODEX_PATH
  if [[ -e "$WORKSPACES_ROOT" ]]; then
    [[ -d "$WORKSPACES_ROOT" && -w "$WORKSPACES_ROOT" ]] || fail "workspace root is not a writable directory"
  else
    local parent; parent="$(dirname "$WORKSPACES_ROOT")"; [[ -d "$parent" && -w "$parent" ]] || fail "workspace root parent is not writable"
  fi
}

preflight() {
  validate_release
  validate_release_file "$RELEASE_DIR/ops/ppp/systemd/$UNIT" "PPP systemd unit"
  validate_release_file "$RELEASE_DIR/ops/ppp/multica-daemon-ppp.sh" "PPP daemon wrapper"
  validate_binary
  read_env || true
  WORKSPACES_ROOT="${WORKSPACES_ROOT:-/var/lib/multica-ppp/workspaces}"
  discover_codex
  validate_env_values
  validate_profile
  [[ -x "$SYSTEMCTL" || "$(command -v "$SYSTEMCTL" 2>/dev/null || true)" ]] || fail "systemctl executable is missing"
  if [[ "$mode" == install ]]; then validate_port; fi
}

backup_file() {
  local src="$1" name="$2"; [[ -e "$src" ]] || return 1
  cp -p "$src" "$BACKUP_DIR/$name"
  printf '%s\n' present >"$BACKUP_DIR/$name.present"
  stat -c '%a' "$src" 2>/dev/null >"$BACKUP_DIR/$name.mode" || stat -f '%Lp' "$src" >"$BACKUP_DIR/$name.mode"
  return 0
}

restore_file() {
  local dst="$1" name="$2"
  if [[ -f "$BACKUP_DIR/$name.present" ]]; then
    local mode="0600"; [[ -r "$BACKUP_DIR/$name.mode" ]] && mode="$(<"$BACKUP_DIR/$name.mode")"
    install -m "$mode" "$BACKUP_DIR/$name" "$dst"
  else
    rm -f "$dst"
  fi
}

install_mode() {
  preflight
  if ((dry_run)); then
    printf 'would install release %s, binary %s, Codex %s, profile %s, health port %s\n' "$RELEASE_DIR" "$DAEMON_BIN" "$CODEX_PATH" "$PROFILE" "$HEALTH_PORT"
    return
  fi
  local was_enabled=0
  if "$SYSTEMCTL" --user is-enabled --quiet "$UNIT"; then was_enabled=1; fi
  BACKUP_DIR="$BACKUP_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-$$"
  mkdir -p "$BACKUP_DIR" "$USER_DIR" "$(dirname "$WRAPPER_DST")" "$(dirname "$ENV_FILE")" "$WORKSPACES_ROOT"
  backup_file "$UNIT_DST" unit || true; backup_file "$WRAPPER_DST" wrapper || true; backup_file "$ENV_FILE" env || true
  printf '%s\n' "$BACKUP_DIR" >"$BACKUP_ROOT/latest"
  rollback_install() {
    local rc=$?; set +e
    ((rc == 0)) && rc=1
    restore_file "$UNIT_DST" unit; restore_file "$WRAPPER_DST" wrapper; restore_file "$ENV_FILE" env
    if ((was_enabled)); then
      "$SYSTEMCTL" --user enable "$UNIT" >/dev/null 2>&1 || true
    else
      "$SYSTEMCTL" --user disable "$UNIT" >/dev/null 2>&1 || true
    fi
    "$SYSTEMCTL" --user daemon-reload >/dev/null 2>&1 || true
    trap - ERR INT TERM HUP
    exit "$rc"
  }
  trap rollback_install ERR INT TERM HUP
  install -m 0644 "$RELEASE_DIR/ops/ppp/systemd/$UNIT" "$UNIT_DST"
  install -m 0755 "$RELEASE_DIR/ops/ppp/multica-daemon-ppp.sh" "$WRAPPER_DST"
  umask 077
  { printf 'MULTICA_SERVER_URL=%s\n' "$SERVER_URL"; printf 'MULTICA_WORKSPACES_ROOT=%s\n' "$WORKSPACES_ROOT"; printf 'MULTICA_CODEX_PATH=%s\n' "$CODEX_PATH"; printf 'MULTICA_DAEMON_BIN=%s\n' "$DAEMON_BIN"; printf 'MULTICA_DAEMON_ALLOWED_PROVIDERS=codex\n'; } >"$ENV_FILE"
  chmod 0600 "$ENV_FILE"
  run "$SYSTEMCTL" --user daemon-reload
  run "$SYSTEMCTL" --user enable "$UNIT"
  trap - ERR INT TERM HUP
  echo "installed PPP daemon artifacts; daemon remains stopped (backup: $BACKUP_DIR)"
}

check_mode() {
  preflight
  cmp -s "$RELEASE_DIR/ops/ppp/systemd/$UNIT" "$UNIT_DST" || fail "unit missing or drifted"
  cmp -s "$RELEASE_DIR/ops/ppp/multica-daemon-ppp.sh" "$WRAPPER_DST" || fail "wrapper missing or drifted"
  "$SYSTEMCTL" --user is-enabled --quiet "$UNIT" || fail "unit is not enabled"
  echo "OK: PPP daemon prerequisites and installed artifacts"
}

uninstall_mode() {
  if "$SYSTEMCTL" --user is-active --quiet "$UNIT"; then
    ((confirm_stop)) || fail "unit is active; rerun with --confirm-stop to stop before uninstall"
    "$SYSTEMCTL" --user stop "$UNIT" || fail "could not stop active unit"
    "$SYSTEMCTL" --user is-active --quiet "$UNIT" && fail "unit remained active after stop"
  fi
  "$SYSTEMCTL" --user disable "$UNIT" >/dev/null 2>&1 || fail "could not disable unit"
  local latest=""; [[ -r "$BACKUP_ROOT/latest" ]] && latest="$(<"$BACKUP_ROOT/latest")"
  if [[ -n "$latest" && -d "$latest" ]]; then BACKUP_DIR="$latest"; restore_file "$UNIT_DST" unit; restore_file "$WRAPPER_DST" wrapper; restore_file "$ENV_FILE" env; else rm -f "$UNIT_DST" "$WRAPPER_DST" "$ENV_FILE"; fi
  "$SYSTEMCTL" --user daemon-reload || fail "systemd daemon-reload failed"
  echo "PPP daemon artifacts removed or restored; workspace and profile data were retained"
}

case "$mode" in
  install) install_mode ;;
  check) check_mode ;;
  uninstall) uninstall_mode ;;
esac
