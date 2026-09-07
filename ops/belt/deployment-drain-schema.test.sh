#!/usr/bin/env bash
# The drain snapshot is one SQL statement. If any relation it names is absent
# from the database, PostgreSQL aborts the whole statement, deployment_wait_for_drain
# returns non-zero on every poll, and no deploy can ever confirm a drain.
#
# That is not hypothetical. The first version of this snapshot counted
# `cicd_deploy_attempt`, a table that exists only in the superseded
# ops/gsp-belt noc2 tree and in none of the 351 canonical migrations. CI passed
# it anyway, because the unit test stubs psql and the integration test creates
# its own tables -- both certified against a schema production does not have.
#
# This test compares the snapshot against server/migrations, which is what the
# Multica database is actually built from, so a relation that production cannot
# have fails here instead of at the first real deploy.
set -Eeuo pipefail
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$root_dir/../.." && pwd)"
migrations_dir="$repo_root/server/migrations"
[[ -d "$migrations_dir" ]] || { echo "canonical migrations not found at $migrations_dir" >&2; exit 1; }

# Read the relations out of the snapshot itself. A hardcoded second list would
# drift from the query it is supposed to be checking.
snapshot_sql="$(awk '/^deployment_drain_snapshot\(\) \{/,/^\}/' "$root_dir/deployment-drain.sh")"
[[ -n "$snapshot_sql" ]] || { echo 'could not read deployment_drain_snapshot from deployment-drain.sh' >&2; exit 1; }

mapfile -t relations < <(grep -oiE '\bFROM[[:space:]]+[a-z_][a-z0-9_]*' <<<"$snapshot_sql" \
  | awk '{print tolower($2)}' | sort -u)
(( ${#relations[@]} > 0 )) || { echo 'snapshot names no relations; the parser is broken' >&2; exit 1; }

assertions=0
for relation in "${relations[@]}"; do
  if ! grep -rliE "CREATE TABLE[[:space:]]+(IF NOT EXISTS[[:space:]]+)?(public\.)?${relation}\b" \
      "$migrations_dir" >/dev/null; then
    echo "drain snapshot counts '${relation}', which no canonical migration creates." >&2
    echo "The snapshot aborts against the real database. Remove the term or cite the migration." >&2
    exit 1
  fi
  assertions=$(( assertions + 1 ))
done

# The callbacks term must stay correlated to a live task. Counting every pending
# row reintroduces a drain that never returns: measured live on 2026-09-07 that
# was 1588 rows, of which 2 were task-live. The authority for correlation rather
# than age is multica-relay-advance-daemon.cjs:858.
callbacks_term="$(sed -n "/'callbacks=' ||/,/))$/p" <<<"$snapshot_sql")"
[[ -n "$callbacks_term" ]] || { echo 'could not isolate the callbacks term' >&2; exit 1; }
if ! grep -qiE 'JOIN[[:space:]]+agent_task_queue' <<<"$callbacks_term"; then
  echo 'callbacks term lost its agent_task_queue join.' >&2
  echo 'It would count pending rows the advancer never consumes, and the drain would never return.' >&2
  exit 1
fi
if ! grep -qiE "status[[:space:]]+IN[[:space:]]*\([[:space:]]*'dispatched'[[:space:]]*,[[:space:]]*'running'[[:space:]]*\)" <<<"$callbacks_term"; then
  echo "callbacks term no longer restricts the joined task to ('dispatched','running')." >&2
  exit 1
fi
assertions=$(( assertions + 2 ))

# A term that always reports zero is worse than an absent one: it would claim a
# clean drain while that work was live. Keep the count honest instead.
if grep -qiE 'coalesce\([^)]*to_regclass|to_regclass' <<<"$snapshot_sql"; then
  echo 'drain snapshot guards a relation with to_regclass; a term that degrades to zero hides live work' >&2
  exit 1
fi
assertions=$(( assertions + 1 ))

# Optional live proof against a production-shaped database. Set explicitly, so a
# CI database that merely happens to be empty cannot certify this by accident.
live_url="${BELT_DRAIN_LIVE_DATABASE_URL:-}"
if [[ -n "$live_url" ]]; then
  output="$(BELT_DEPLOY_DATABASE_URL="$live_url" bash -c ". '$root_dir/deployment-drain.sh'; deployment_drain_snapshot")" || {
    echo 'drain snapshot failed against the live database' >&2; exit 1; }
  grep -qE '^leases=[0-9]+ children=[0-9]+ callbacks=[0-9]+$' <<<"$output" || {
    echo "live drain snapshot returned an unexpected shape: $output" >&2; exit 1; }
  echo "live drain snapshot: $output"
  assertions=$(( assertions + 1 ))
  echo "deployment drain schema tests passed: ${assertions} assertions, 0 skipped"
else
  echo "deployment drain schema tests passed: ${assertions} assertions, 1 skipped (set BELT_DRAIN_LIVE_DATABASE_URL for the live snapshot)"
fi
