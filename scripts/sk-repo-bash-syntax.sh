#!/usr/bin/env bash
set -Eeuo pipefail
while IFS= read -r -d '' file; do bash -n -- "$file" || { echo "bash syntax: $file" >&2; exit 1; }; done < <(git ls-files -z -- '*.sh' '*.bash')
