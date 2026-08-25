-- PPP-20833 / PPP-20825: roll back the open-number partial unique index.
-- Single-statement file required for DROP INDEX CONCURRENTLY.
DROP INDEX CONCURRENTLY IF EXISTS uq_issue_workspace_number_open;
