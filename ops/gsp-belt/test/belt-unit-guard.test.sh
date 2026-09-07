#!/usr/bin/env bash
set -Eeuo pipefail
root="$(cd -- "$(dirname -- "$0")/.." && pwd)"; fixture="$(mktemp -d)"
cat > "$fixture/systemctl" <<'SH'
#!/usr/bin/env bash
case "$1" in is-enabled) exit 0;; is-active) [[ "$2" == multica-archiver.service ]] && { echo inactive; exit 3; } || echo active;; show) echo 'Mon 2026-09-07 10:35:15 UTC';; start) exit 99;; esac
SH
cat > "$fixture/journalctl" <<'SH'
#!/usr/bin/env bash
echo 'Sep 07 sudo[1]: COMMAND=/usr/bin/systemctl stop multica-archiver.service'
SH
cat > "$fixture/logger" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$fixture/systemctl" "$fixture/journalctl" "$fixture/logger"
if PATH="$fixture:$PATH" "$root/scripts/belt-unit-guard.sh" --check > "$fixture/out"; then echo 'inactive unit passed check' >&2; exit 1; fi
grep -q 'would-start unit=multica-archiver state=inactive inactive_since=Mon 2026-09-07 10:35:15 UTC' "$fixture/out"
grep -q 'systemctl stop multica-archiver.service' "$fixture/out"
echo 'belt unit guard regression passed'
