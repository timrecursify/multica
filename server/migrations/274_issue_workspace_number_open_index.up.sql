-- PPP-20833 / PPP-20825: make the per-workspace open-number uniqueness durable.
--
-- Migration 020 intended a full UNIQUE (workspace_id, number) constraint, but
-- the historical 20819 pair (both now terminal) made that impossible to apply
-- without mutation. The accepted invariant (ticket 20825) is a PARTIAL unique
-- index over OPEN rows only: terminal rows (Done/Cancelled/cancelled/Archived)
-- are excluded, so historical terminal duplicates are tolerated while the
-- allocator can never mint a second open row for the same number. This has
-- already been applied on the production database manually; this single-
-- statement CONCURRENTLY file persists the invariant in the repo so a fresh or
-- restored database gets it too. IF NOT EXISTS is a no-op where present.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_issue_workspace_number_open
    ON issue (workspace_id, number)
    WHERE status NOT IN ('Done', 'done', 'Cancelled', 'cancelled', 'Archived');
