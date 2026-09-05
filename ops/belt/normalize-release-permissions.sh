#!/usr/bin/env bash
# Make an immutable release traversable by service consumers.
set -euo pipefail

[[ $# == 1 && -d $1 ]] || { echo "usage: $0 RELEASE_ROOT" >&2; exit 64; }
root=$1

# Credential material keeps its existing read scope; immutable code and data
# must be readable, while every release path remains non-writable.
is_credential() {
  case ${1##*/} in
    .env|.env.*|*secret*|*credential*|*.key|*.pem|*.p12|*.pfx) return 0 ;;
    *) return 1 ;;
  esac
}

find "$root" -type d -exec chmod a+rx,a-w -- {} +
while IFS= read -r -d '' file; do
  if is_credential "$file"; then
    chmod a-w -- "$file"
  else
    chmod a+r,a-w -- "$file"
  fi
done < <(find "$root" -type f -print0)
