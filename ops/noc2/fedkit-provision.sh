#!/usr/bin/env bash
set -Eeuo pipefail
DEVICE=${DEVICE:-/dev/sda}; ISO=${ISO:-}; MOUNT=${MOUNT:-/run/media/root/FEDKIT}; DRY_RUN=${DRY_RUN:-0}; ISO_SHA256=${ISO_SHA256:-}; HEADER_BACKUP=${HEADER_BACKUP:-}
[[ "$DEVICE" == /dev/sda ]] || { echo 'refusing device: expected /dev/sda' >&2; exit 2; }
[[ -b "$DEVICE" ]] || { echo "wrong or missing device: $DEVICE" >&2; exit 3; }
[[ -n "$ISO" && -r "$ISO" ]] || { echo 'Mint ISO required' >&2; exit 5; }
[[ -n "$ISO_SHA256" ]] || { echo 'ISO_SHA256 required' >&2; exit 5; }
[[ -n "$HEADER_BACKUP" && "$HEADER_BACKUP" != "$DEVICE"* ]] || { echo 'off-stick HEADER_BACKUP required' >&2; exit 5; }
[[ -z "$(lsblk -nr -o MOUNTPOINT "$DEVICE" 2>/dev/null | tr -d ' ')" ]] || { echo 'device is mounted' >&2; exit 7; }
actual=$(sha256sum "$ISO" | awk '{print $1}'); [[ "$actual" == "$ISO_SHA256" ]] || { echo 'ISO checksum mismatch' >&2; exit 8; }
if (( DRY_RUN )); then echo "would verify $DEVICE, install Ventoy, copy ${ISO:-Mint ISO}, create LUKS vault, and record off-stick header backup"; exit 0; fi
command -v ventoy >/dev/null || { echo 'ventoy is required' >&2; exit 4; }
echo 'Refusing destructive provisioning without FEDKIT_CONFIRM=YES' >&2
[[ ${FEDKIT_CONFIRM:-} == YES ]] || exit 6
ventoy -i "$DEVICE"
cryptsetup luksFormat --type luks2 "$DEVICE"2
cryptsetup luksHeaderBackup "$DEVICE"2 --header-backup-file "$HEADER_BACKUP"
[[ -s "$HEADER_BACKUP" ]] || { echo 'header backup missing' >&2; exit 9; }
echo "Provisioned $DEVICE; ISO checksum $actual; header backup verified at off-stick path."
