#!/usr/bin/env bash
set -Eeuo pipefail
while IFS= read -r -d '' file; do
  if grep -n $'\t' -- "$file"; then echo "docs lint: tab in $file" >&2; exit 1; fi
done < <(git ls-files -z -- '*.md' '*.mdx')
