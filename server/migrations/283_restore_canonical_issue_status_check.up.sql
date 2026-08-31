-- Restore the production relay vocabulary after 282's incompatible rewrite.
-- Migration 282 records every pre-up status in this sidecar. Only restore a
-- value when the row still has the exact value 282 produced, so a later user
-- update is never overwritten by this repair.
ALTER TABLE issue DROP CONSTRAINT IF EXISTS issue_status_check;

UPDATE issue AS i
SET status = rollback.previous_status
FROM issue_status_282_rollback AS rollback
WHERE i.id = rollback.issue_id
  AND i.status = 'Spec'
  AND rollback.previous_status IN ('Registered', 'CI/CD & Deploy');

UPDATE issue
SET status = CASE status
    WHEN 'in_progress' THEN 'In Progress'
    WHEN 'in_review' THEN 'In Review'
    ELSE status
END
WHERE status IN ('in_progress', 'in_review');

ALTER TABLE issue ADD CONSTRAINT issue_status_check CHECK (status IN
    ('Registered', 'Spec', 'Queue', 'In Progress', 'In Review',
     'Human Review', 'CI/CD & Deploy', 'Done', 'Archived', 'Cancelled'));

ALTER TABLE issue ALTER COLUMN status SET DEFAULT 'Spec';
