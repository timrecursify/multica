#!/usr/bin/env bash
set -euo pipefail
repo=$(mktemp -d); trap 'rm -rf "$repo"' EXIT
mkdir -p "$repo/migrations"; git -C "$repo" init -q; git -C "$repo" config user.email test@example.com; git -C "$repo" config user.name test
touch "$repo/migrations/1_existing.sql"; git -C "$repo" add .; git -C "$repo" commit -qm seed; git -C "$repo" branch -M main
printf '2|2026-01-01\n' >"$repo/prod"; export MIGRATION_ROOT="$repo" RESERVED_FILE="$repo/RESERVED.md" PRODUCTION_MIGRATIONS_FILE="$repo/prod"
a=$(scripts/migrations/claim-slot.sh T-A); b=$(scripts/migrations/claim-slot.sh T-B); [[ "$a" != "$b" && "$a" == 3 && "$b" == 4 ]]
[[ $(scripts/migrations/claim-slot.sh T-A) == "$a" ]]
if scripts/ci/check-migration-slot.sh "$repo/migrations/2_bad.sql"; then exit 1; fi
grep -q 'slot=3 ticket=T-A provenance=machine:claim-slot.sh' "$repo/RESERVED.md"
echo 'migration slot checks passed'
