#!/bin/bash
# belt-fingerprint — verify every tracked runtime file in a release matches its
# source commit (drift detection). Reads the manifest file list plus the live
# migration-provenance SHA table from the source tree and recomputes checksums
# of the deployed release.
#
#   bash ops/gsp-belt/scripts/belt-fingerprint.sh --checkout <dir> --release <dir>
#
# Exit 0 = no drift; exit 1 = drift/missing. Requires sha256sum.
set -euo pipefail

checkout_root=""; release_dir=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --checkout) checkout_root="$2"; shift 2;;
    --release) release_dir="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
[[ -n "$checkout_root" && -n "$release_dir" ]] || { echo "usage: belt-fingerprint.sh --checkout DIR --release DIR" >&2; exit 2; }

MANIFEST_REL="ops/gsp-belt/MANIFEST.md"
manifest_release="$release_dir/$MANIFEST_REL"
manifest_src="$checkout_root/$MANIFEST_REL"
[[ -f "$manifest_release" ]] || { echo "fingerprint: release manifest missing: $manifest_release" >&2; exit 1; }

mapfile -t src_files < <(sed -nE 's/^\| `([^`]*)` .*/\1/p' "$manifest_src" | sort -u)

fail=0
for rel in "${src_files[@]}"; do
  [[ -n "$rel" ]] || continue
  src="$checkout_root/$rel"; rel_current="$release_dir/$rel"
  [[ -f "$src" ]] || { echo "fingerprint: source missing (untracked): $rel"; fail=1; continue; }
  [[ -f "$rel_current" ]] || { echo "fingerprint: DRIFT — deployed file missing: $rel"; fail=1; continue; }
  if ! cmp -s "$src" "$rel_current"; then
    echo "fingerprint: DRIFT — deployed differs from source: $rel"
    fail=1
  else
    echo "fingerprint: ok $rel ($(sha256sum "$src" | cut -d' ' -f1))"
  fi
done
if [[ $fail -eq 0 ]]; then echo "fingerprint: NO DRIFT — all manifest sources match selected ref"; fi
exit $fail
