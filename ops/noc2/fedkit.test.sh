#!/usr/bin/env bash
set -Eeuo pipefail
root=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
grep -q 'OnUnitActiveSec=15min' "$root/fedkit-backup.timer"
grep -q '/dev/sda' "$root/fedkit-provision.sh"
grep -q 'old-host-fenced' "$root/fedkit-restore.sh"
fixture=$(mktemp -d); trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/stick" "$fixture/bin"
cat >"$fixture/bin/restic" <<'EOF'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >"$RESTIC_LOG"
EOF
chmod +x "$fixture/bin/restic"
RESTIC_LOG="$fixture/restic.log" PATH="$fixture/bin:$PATH" STICK_MOUNT="$fixture/stick" DRY_RUN=1 "$root/fedkit-backup.sh" | grep -q -- '--files-from'
if CHECKPOINT="$fixture/checkpoint" DRY_RUN=1 "$root/fedkit-restore.sh" 2>/dev/null; then exit 1; fi
touch "$fixture/checkpoint"
CHECKPOINT="$fixture/checkpoint" DRY_RUN=1 "$root/fedkit-restore.sh" | grep -q 'no writes'
echo PASS
