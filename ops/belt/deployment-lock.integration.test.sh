#!/usr/bin/env bash
set -Eeuo pipefail
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
: "${DATABASE_URL:?DATABASE_URL is required; refusing to skip deployment-lock integration tests}"
schema="deployment_lock_$$"
cleanup() { psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "DROP SCHEMA IF EXISTS $schema CASCADE" >/dev/null; }
trap cleanup EXIT

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<SQL >/dev/null
CREATE SCHEMA $schema;
SET search_path TO $schema;
CREATE TABLE agent_task_queue (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status text NOT NULL, prepare_lease_expires_at timestamptz, parent_task_id bigint);
CREATE TABLE relay_run_log (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, status text NOT NULL);
\i $root_dir/deployment-lock.sql
UPDATE belt_deployment_control SET admission_held = true WHERE singleton;
SQL

rejects() {
  if psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "SET search_path TO $schema; $1" >/dev/null 2>&1; then
    echo "admission unexpectedly succeeded: $1" >&2; exit 1
  fi
}
rejects "INSERT INTO agent_task_queue(status) VALUES ('queued')"
rejects "INSERT INTO agent_task_queue(status) VALUES ('dispatched')"
rejects "INSERT INTO relay_run_log(status) VALUES ('pending')"

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<SQL >/dev/null
SET search_path TO $schema;
UPDATE belt_deployment_control SET admission_held = false WHERE singleton;
INSERT INTO agent_task_queue(status) VALUES ('running');
INSERT INTO relay_run_log(status) VALUES ('pending');
UPDATE belt_deployment_control SET admission_held = true WHERE singleton;
UPDATE agent_task_queue SET status = 'completed';
UPDATE relay_run_log SET status = 'completed';
SQL
[[ "$(psql "$DATABASE_URL" -XAtqc "SET search_path TO $schema; SELECT count(*) FROM agent_task_queue WHERE status='completed'")" == 1 ]]
echo 'deployment admission integration tests passed: 3 assertions, 0 skipped'
