#!/usr/bin/env bash
set -euo pipefail
file=${1:?usage: $0 migration.sql}; name=$(basename "$file")
[[ $name =~ ^([0-9]+)_[^/]+\.sql$ ]] || { echo "invalid migration filename: $name" >&2; exit 2; }
slot=${BASH_REMATCH[1]}; root=${MIGRATION_ROOT:-$(git rev-parse --show-toplevel)}
hit=$(git -C "$root" ls-tree -r --name-only origin/main 2>/dev/null | grep -E "/${slot}_[^/]+\.sql$" | head -1 || true)
[[ -n $hit && $hit != $file ]] && { echo "migration slot $slot occupied by $hit (source: main)" >&2; exit 1; }
if [[ -f ${OPEN_PR_MIGRATIONS_FILE:-} ]]; then hit=$(grep -E "/${slot}_[^/]+\.sql$" "$OPEN_PR_MIGRATIONS_FILE" | head -1 || true); [[ -n $hit ]] && { echo "migration slot $slot occupied by $hit (source: open-pr)" >&2; exit 1; }; fi
echo "migration slot $slot is available"
