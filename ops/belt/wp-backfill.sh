#!/usr/bin/env bash
set -euo pipefail

# Narrow privileged entry point for the work-product backfill.  The caller can
# invoke only the reviewed backfill modes; the relay credentials never become
# command-line arguments or part of the helper's output.
env_file="${WP_BACKFILL_ENV_FILE:-/etc/gsp/multica/multica-relay-advance.env}"
case "${1-}" in
  --dry-run|--apply) mode="$1"; shift ;;
  *) printf '%s\n' 'usage: wp-backfill (--dry-run|--apply) [reviewed backfill options]' >&2; exit 2 ;;
esac

# Keep the allowlist explicit.  These are the only options accepted by the
# reviewed child; no shell, SQL, or environment inspection primitive is exposed.
for arg in "$@"; do
  case "$arg" in
    --batch-size|--workspace|--recover-runtime-evidence-issue)
      printf '%s\n' "${arg#--} requires a value" >&2; exit 2 ;;
    --batch-size=*|--workspace=*|--recover-runtime-evidence-issue=*) ;;
    --retry-runtime-evidence) [[ "$mode" == --apply ]] || { printf '%s\n' 'retry requires --apply' >&2; exit 2; } ;;
    *) printf '%s\n' 'unknown backfill option' >&2; exit 2 ;;
  esac
done

[[ -r "$env_file" ]] || { printf '%s\n' 'backfill environment unavailable' >&2; exit 1; }
# shellcheck disable=SC1090
source "$env_file"
[[ -n "${DATABASE_URL:-}" ]] || { printf '%s\n' 'DATABASE_URL is required' >&2; exit 1; }
export DATABASE_URL
unset env_file
exec /usr/bin/node /opt/gsp/multica-workers/gsp-multica-bridge/backfill-parked-diagnosis.cjs "$mode" "$@"
