#!/usr/bin/env bash
set -Eeuo pipefail
DEVICE=${DEVICE:-/dev/sda}; ISO=${ISO:-}; MOUNT=${MOUNT:-/run/media/root/FEDKIT}; DRY_RUN=${DRY_RUN:-0}
[[ "$DEVICE" == /dev/sd* ]] || { echo 'refusing non-USB device' >&2; exit 2; }
[[ -b "$DEVICE" ]] || { echo "wrong or missing device: $DEVICE" >&2; exit 3; }
if (( DRY_RUN )); then echo "would verify $DEVICE, install Ventoy, copy ${ISO:-Mint ISO}, create LUKS vault, and record off-stick header backup"; exit 0; fi
command -v ventoy >/dev/null || { echo 'ventoy is required' >&2; exit 4; }
[[ -n "$ISO" && -r "$ISO" ]] || { echo 'Mint ISO required' >&2; exit 5; }
echo 'Refusing destructive provisioning without FEDKIT_CONFIRM=YES' >&2
[[ ${FEDKIT_CONFIRM:-} == YES ]] || exit 6
ventoy -i "$DEVICE"
echo 'Provision Ventoy data partition, LUKS vault, and off-stick header backup using site procedure.'
