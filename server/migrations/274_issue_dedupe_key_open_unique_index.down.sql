-- PPP-20833: roll back the dedupe_key partial unique index.
-- Single-statement file required for DROP INDEX CONCURRENTLY.
DROP INDEX CONCURRENTLY IF EXISTS uq_issue_workspace_dedupe_key_open;
