#!/usr/bin/env bash
set -euo pipefail
while IFS= read -r -d '' file; do
  bash -n "$file" || exit $?
done < <(git ls-files -z -- '*.sh')
