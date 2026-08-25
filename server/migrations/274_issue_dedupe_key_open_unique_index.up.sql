-- PPP-20833: partial UNIQUE index on (workspace_id, dedupe_key) for OPEN issues.
--
-- Terminal (Done / Cancelled / cancelled / Archived) issues are excluded so a
-- resolved ticket never blocks a fresh fire for the same key tomorrow. Only
-- rows with a non-NULL dedupe_key participate. Single-statement file required
-- for CREATE INDEX CONCURRENTLY. When a create supplies a dedupe_key already
-- held by an open issue in the workspace, the index rejects the INSERT with
-- 23505 and the create path returns the existing ticket (HTTP 200 existing:true).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_issue_workspace_dedupe_key_open
    ON issue (workspace_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL
      AND status NOT IN ('Done', 'done', 'Cancelled', 'cancelled', 'Archived');
