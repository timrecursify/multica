#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")" && pwd)
helper="$root/wp-backfill.sh"

# The production path is literal and cannot be overridden by the caller.
grep -Fq 'readonly env_file=/etc/gsp/multica/multica-relay-advance.env' "$helper"
if grep -Fq 'WP_BACKFILL_ENV_FILE' "$helper"; then
  echo 'caller-controlled env override remains' >&2
  exit 1
fi

# Unknown commands and options fail closed without attempting to read secrets.
if "$helper" --shell >/tmp/wp-backfill.out 2>/tmp/wp-backfill.err; then
  echo 'unknown command unexpectedly succeeded' >&2
  exit 1
fi
grep -Fq 'usage: wp-backfill' /tmp/wp-backfill.err
! grep -Eq 'DATABASE_URL|fixture-secret|postgres://' /tmp/wp-backfill.out /tmp/wp-backfill.err

# Manifest and deployment closure include the helper.
grep -Fq '"$root_dir/wp-backfill.sh"' "$root/belt-manifest.sh"
grep -Fq '"$global_bin_root/wp-backfill"' "$root/belt-manifest.sh"
echo 'wp-backfill contract: PASS'
