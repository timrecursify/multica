#!/usr/bin/env bash
set -Eeuo pipefail
DEVICE=${DEVICE:-/dev/sda}; ISO=${ISO:-}; MOUNT=${MOUNT:-/run/media/root/FEDKIT}; DRY_RUN=${DRY_RUN:-0}
[[ "$DEVICE" == /dev/sd* ]] || { echo 'refusing non-USB device' >&2; exit 2; }
[[ -b "$DEVICE" ]] || { echo "wrong or missing device: $DEVICE" >&2; exit 3; }
MODEL=${MODEL:-Kingston DataTraveler}; SERIAL=${SERIAL:-}; HEADER_BACKUP=${HEADER_BACKUP:-}
expected=$(udevadm info --query=property --name="$DEVICE" 2>/dev/null || true)
grep -qi "ID_MODEL=.*Kingston\|ID_MODEL_FROM_DATABASE=.*Kingston" <<<"$expected" || { echo 'expected Kingston device required' >&2; exit 7; }
[[ -n "$SERIAL" ]] && grep -q "ID_SERIAL_SHORT=$SERIAL" <<<"$expected" || [[ -n "$SERIAL" ]] || { echo 'device serial required' >&2; exit 8; }
findmnt -rn -S "$DEVICE" >/dev/null && { echo 'device is mounted' >&2; exit 9; }
[[ -n "$HEADER_BACKUP" && "$HEADER_BACKUP" != "$DEVICE"* ]] || { echo 'off-stick header backup path required' >&2; exit 10; }
if (( DRY_RUN )); then echo "would verify $DEVICE, install Ventoy, copy ${ISO:-Mint ISO}, create LUKS2 vault, and record off-stick header backup at $HEADER_BACKUP"; exit 0; fi
command -v ventoy >/dev/null || { echo 'ventoy is required' >&2; exit 4; }
[[ -n "$ISO" && -r "$ISO" ]] || { echo 'Mint ISO required' >&2; exit 5; }
echo 'Refusing destructive provisioning without FEDKIT_CONFIRM=YES' >&2
[[ ${FEDKIT_CONFIRM:-} == YES ]] || exit 6
ventoy -i "$DEVICE"
[[ -r "$ISO" ]] || { echo 'Mint ISO required' >&2; exit 5; }
sha256sum "$ISO" >/dev/null || exit 11
command -v cryptsetup >/dev/null || { echo 'cryptsetup is required' >&2; exit 12; }
cryptsetup luksFormat --type luks2 "$DEVICE"2
cryptsetup luksHeaderBackup "$DEVICE"2 --header-backup-file "$HEADER_BACKUP"
[[ -s "$HEADER_BACKUP" ]] || { echo 'header backup verification failed' >&2; exit 13; }
