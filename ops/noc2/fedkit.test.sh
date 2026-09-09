#!/usr/bin/env bash
set -Eeuo pipefail
root=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
grep -q 'OnUnitActiveSec=15min' "$root/fedkit-backup.timer"
grep -q '/dev/sda' "$root/fedkit-provision.sh"
grep -q 'old-host-fenced' "$root/fedkit-restore.sh"
fixture=$(mktemp -d); trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/stick" "$fixture/bin"
printf secret >"$fixture/password"; chmod 600 "$fixture/password"
cat >"$fixture/bin/restic" <<'EOF'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >"$RESTIC_LOG"
EOF
chmod +x "$fixture/bin/restic"
RESTIC_LOG="$fixture/restic.log" PASSWORD_FILE="$fixture/password" PATH="$fixture/bin:$PATH" STICK_MOUNT="$fixture/stick" DRY_RUN=1 "$root/fedkit-backup.sh" | grep -q -- '--files-from'
if CHECKPOINT="$fixture/checkpoint" STAGING="$fixture/staging" DRY_RUN=1 "$root/fedkit-restore.sh" 2>/dev/null; then exit 1; fi
printf 'host_id=huawei\n' >"$fixture/checkpoint"
CHECKPOINT="$fixture/checkpoint" STAGING="$fixture/staging" RESTIC_LOG="$fixture/restic.log" PATH="$fixture/bin:$PATH" DRY_RUN=1 "$root/fedkit-restore.sh" | grep -q 'no live writes'
echo PASS
