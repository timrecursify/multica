#!/usr/bin/env bash
set -Eeuo pipefail
DEVICE=${DEVICE:-/dev/sda}; ISO=${ISO:-}; MOUNT=${MOUNT:-/run/media/root/FEDKIT}; DRY_RUN=${DRY_RUN:-0}
[[ "$DEVICE" == /dev/sd* ]] || { echo 'refusing non-USB device' >&2; exit 2; }
[[ -b "$DEVICE" ]] || { echo "wrong or missing device: $DEVICE" >&2; exit 3; }
[[ "$DEVICE" == /dev/sda ]] || { echo 'refusing unexpected device (expected /dev/sda)' >&2; exit 3; }
sys=/sys/class/block/$(basename "$DEVICE")
model=$(cat "$sys/device/model" 2>/dev/null || true); size=$(cat "$sys/size" 2>/dev/null || true)
[[ "$model" == *Kingston*DataTraveler* ]] || { echo "refusing device model: $model" >&2; exit 3; }
(( size >= 110000000 && size <= 130000000 )) || { echo "refusing device capacity: $size sectors" >&2; exit 3; }
if (( DRY_RUN )); then echo "would verify $DEVICE, install Ventoy, copy ${ISO:-Mint ISO}, create LUKS vault, and record off-stick header backup"; exit 0; fi
command -v ventoy >/dev/null || { echo 'ventoy is required' >&2; exit 4; }
[[ -n "$ISO" && -r "$ISO" ]] || { echo 'Mint ISO required' >&2; exit 5; }
echo 'Refusing destructive provisioning without FEDKIT_CONFIRM=YES' >&2
[[ ${FEDKIT_CONFIRM:-} == YES ]] || exit 6
ventoy -i "$DEVICE"
cryptsetup luksFormat "${DEVICE}2"
cryptsetup luksHeaderBackup "${DEVICE}2" --header-backup-file "${LUKS_HEADER_BACKUP:?set LUKS_HEADER_BACKUP outside stick}"
cryptsetup luksOpen "${DEVICE}2" fedkit
restic -r /dev/mapper/fedkit init
