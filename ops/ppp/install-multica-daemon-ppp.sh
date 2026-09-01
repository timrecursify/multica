#!/usr/bin/env bash
# Install or verify the PPP user unit and locked daemon entrypoint.
# This script never starts or restarts the daemon.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT="multica-daemon-ppp.service"
USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_SRC="$ROOT/systemd/$UNIT"
WRAPPER_SRC="$ROOT/multica-daemon-ppp.sh"
UNIT_DST="$USER_DIR/$UNIT"
WRAPPER_DST="${MULTICA_DAEMON_WRAPPER_DEST:-$HOME/bin/multica-daemon-ppp.sh}"

mode=install
dry_run=0
for arg in "$@"; do
  case "$arg" in
    --check) mode=check ;;
    --uninstall) mode=uninstall ;;
    --dry-run) dry_run=1 ;;
    *) echo "usage: $0 [--check|--uninstall] [--dry-run]" >&2; exit 64 ;;
  esac
done

run() {
  if [[ "$dry_run" == 1 ]]; then
    printf 'would run: %s\n' "$*"
  else
    "$@"
  fi
}

case "$mode" in
  check)
    if [[ ! -f "$UNIT_DST" ]] || ! cmp -s "$UNIT_SRC" "$UNIT_DST"; then
      echo "MISSING/DRIFT: $UNIT_DST" >&2
      exit 1
    fi
    if [[ ! -f "$WRAPPER_DST" ]] || ! cmp -s "$WRAPPER_SRC" "$WRAPPER_DST"; then
      echo "MISSING/DRIFT: $WRAPPER_DST" >&2
      exit 1
    fi
    systemctl --user is-enabled --quiet "$UNIT" || { echo "NOT ENABLED: $UNIT" >&2; exit 1; }
    echo "OK: PPP daemon unit and wrapper installed (daemon not started by check)"
    ;;
  uninstall)
    run rm -f "$UNIT_DST" "$WRAPPER_DST"
    run systemctl --user daemon-reload
    if [[ "$dry_run" == 1 ]]; then
      printf 'would run: systemctl --user disable %s\n' "$UNIT"
    else
      systemctl --user disable "$UNIT" >/dev/null 2>&1 || true
    fi
    echo "removed PPP daemon artifacts; any running daemon was not touched"
    ;;
  install)
    [[ -f "$UNIT_SRC" && -f "$WRAPPER_SRC" ]] || { echo "missing source artifact" >&2; exit 2; }
    run mkdir -p "$USER_DIR" "$(dirname "$WRAPPER_DST")"
    run install -m 0644 "$UNIT_SRC" "$UNIT_DST"
    run install -m 0755 "$WRAPPER_SRC" "$WRAPPER_DST"
    run systemctl --user daemon-reload
    if [[ "$dry_run" == 1 ]]; then
      printf 'would run: systemctl --user enable %s\n' "$UNIT"
    else
      systemctl --user enable "$UNIT" >/dev/null
    fi
    echo "installed PPP daemon artifacts; daemon remains stopped"
    ;;
esac
