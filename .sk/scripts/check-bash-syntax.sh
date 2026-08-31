#!/usr/bin/env bash
# Hermetic bash syntax check for the Multica repository (sk repo test profile
# `bash-syntax`). Enumerates tracked shell artifacts without depending on the
# caller's environment, then runs `bash -n` on each and names any offending
# file. Exits nonzero when any file fails to parse.
set -u

repo_root="$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)"
failures=0
count=0

shell_files="$repo_root/.sk/tracked-sh.txt"
if [[ ! -f "$shell_files" ]]; then
    printf 'sk repo test: missing staff listing %s\n' "$shell_files" >&2
    exit 2
fi

while IFS= read -r file; do
    [[ -n "$file" ]] || continue
    path="$repo_root/$file"
    [[ -f "$path" ]] || continue
    count=$((count + 1))
    if ! bash -n "$path" 2>"$repo_root/.sk/bash-syntax.err"; then
        printf '%s: bash -n failed\n' "$file" >&2
        sed 's/^/  /' "$repo_root/.sk/bash-syntax.err" >&2
        failures=$((failures + 1))
    fi
done < "$shell_files"

rm -f -- "$repo_root/.sk/bash-syntax.err"

if ((failures > 0)); then
    printf 'bash-syntax: %d of %d shell files failed to parse\n' "$failures" "$count" >&2
    exit 1
fi

printf 'bash-syntax: %d shell files parsed clean\n' "$count"
