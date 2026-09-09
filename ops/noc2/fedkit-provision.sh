#!/usr/bin/env bash
set -Eeuo pipefail
DEVICE=${DEVICE:-/dev/sda}; ISO=${ISO:-}; ISO_SHA256=${ISO_SHA256:-}; HEADER_BACKUP=${HEADER_BACKUP:-}; MOUNT=${MOUNT:-/run/media/root/FEDKIT}; DRY_RUN=${DRY_RUN:-0}
[[ "$DEVICE" == /dev/sda ]] || { echo 'refusing device other than /dev/sda' >&2; exit 2; }
[[ -b "$DEVICE" ]] || { echo "wrong or missing device: $DEVICE" >&2; exit 3; }
[[ -r /sys/block/sda/device/model && $(tr -d '[:space:]' </sys/block/sda/device/model) == *Kingston* ]] || { echo 'Kingston DataTraveler model required' >&2; exit 3; }
size=$(cat /sys/block/sda/size 2>/dev/null || echo 0); (( size > 110000000 && size < 130000000 )) || { echo 'device capacity is not approximately 62 GB' >&2; exit 3; }
[[ -z $(lsblk -nro MOUNTPOINT "$DEVICE" 2>/dev/null | sed '/^$/d') ]] || { echo 'device or partition is mounted' >&2; exit 3; }
[[ -z $(lsblk -nrpo NAME,TYPE "$DEVICE" 2>/dev/null | awk '$2=="crypt"{print}') ]] || { echo 'device has active holders' >&2; exit 3; }
if (( DRY_RUN )); then echo "would verify $DEVICE, install Ventoy, copy ${ISO:-Mint ISO}, create LUKS vault, and record off-stick header backup"; exit 0; fi
command -v ventoy >/dev/null || { echo 'ventoy is required' >&2; exit 4; }
[[ -n "$ISO" && -r "$ISO" && -n "$ISO_SHA256" ]] || { echo 'Mint ISO and SHA-256 required' >&2; exit 5; }
echo "$ISO_SHA256  $ISO" | sha256sum -c - >/dev/null || { echo 'Mint ISO checksum mismatch' >&2; exit 5; }
[[ -n "$HEADER_BACKUP" && "$HEADER_BACKUP" != "$DEVICE"* ]] || { echo 'off-stick header backup path required' >&2; exit 5; }
echo 'Refusing destructive provisioning without FEDKIT_CONFIRM=YES' >&2
[[ ${FEDKIT_CONFIRM:-} == YES ]] || exit 6
ventoy -i "$DEVICE"
install -D -m 0644 "$ISO" "$MOUNT/$(basename "$ISO")"
cryptsetup luksFormat --type luks2 "$DEVICE"p2
cryptsetup luksHeaderBackup "$DEVICE"p2 --header-backup-file "$HEADER_BACKUP"
cryptsetup isLuks "$DEVICE"p2
restic -r "$MOUNT/restic" init
[[ -s "$HEADER_BACKUP" ]] || { echo 'header backup verification failed' >&2; exit 7; }
echo 'Fedkit provisioning verified.'
