#!/usr/bin/env bash
set -Eeuo pipefail
DEVICE=${DEVICE:-/dev/sda}; ISO=${ISO:-}; MOUNT=${MOUNT:-/run/media/root/FEDKIT}; DRY_RUN=${DRY_RUN:-0}
[[ "$DEVICE" == /dev/sd* ]] || { echo 'refusing non-USB device' >&2; exit 2; }
[[ -b "$DEVICE" ]] || { echo "wrong or missing device: $DEVICE" >&2; exit 3; }
HEADER_BACKUP=${HEADER_BACKUP:-};
if (( DRY_RUN )); then echo "would verify $DEVICE identity $(lsblk -ndo SERIAL "$DEVICE" 2>/dev/null || true), install/update Ventoy, copy ${ISO:-Mint ISO}, create LUKS vault, and save header off-stick"; exit 0; fi
command -v ventoy >/dev/null || { echo 'ventoy is required' >&2; exit 4; }
[[ -n "$ISO" && -r "$ISO" ]] || { echo 'Mint ISO required' >&2; exit 5; }
echo 'Refusing destructive provisioning without FEDKIT_CONFIRM=YES' >&2
[[ ${FEDKIT_CONFIRM:-} == YES ]] || exit 6
ventoy -i "$DEVICE"
cp "$ISO" "$MOUNT/mint.iso"
cryptsetup luksFormat "${DEVICE}2" < /dev/zero
cryptsetup luksHeaderBackup "${DEVICE}2" --header-backup-file "${HEADER_BACKUP:?HEADER_BACKUP must be off-stick}"
