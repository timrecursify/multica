-- PPP-22989 rollback: restore the exact rows changed by the up migration.
-- This deliberately fails if canonical-only writes occurred after migration;
-- it never silently discards newer status data to satisfy the old constraint.
ALTER TABLE issue DROP CONSTRAINT IF EXISTS issue_status_check;

UPDATE issue i
SET status = r.previous_status
FROM issue_status_282_rollback r
WHERE i.id = r.issue_id;

ALTER TABLE issue ADD CONSTRAINT issue_status_check CHECK (status IN
    ('backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'));

DROP TABLE issue_status_282_rollback;
