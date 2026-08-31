#!/usr/bin/env bash
set -euo pipefail
while IFS= read -r file; do
  bash -n "$file" || exit $?
done < <(find . -type f -name '*.sh' -not -path './.git/*' -print)
