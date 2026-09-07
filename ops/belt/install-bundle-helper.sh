#!/usr/bin/env bash
set -euo pipefail

[[ $# == 2 ]] || { echo 'usage: install-bundle-helper.sh RELEASE_ROOT RUNTIME_ROOT' >&2; exit 64; }
release_root=$1
runtime_root=$2
src="$release_root/ops/belt/multica-bundle.py"
dest="$runtime_root/multica-bundle.py"

if [[ ! -f "$src" ]]; then
  echo "missing helper source: $src" >&2
  exit 66
fi
if [[ ! -x "$src" ]]; then
  echo "non-executable helper source: $src" >&2
  exit 66
fi
mkdir -p -- "$runtime_root"
tmp="$runtime_root/.multica-bundle.py.$$"
trap 'rm -f -- "$tmp"' EXIT
cp -- "$src" "$tmp"
chmod 0555 -- "$tmp"
mv -f -- "$tmp" "$dest"
trap - EXIT
