-- PPP-22989: converge issue.status storage on the production board vocabulary.
-- Snapshot every pre-up value before rewriting it so down can restore the
-- exact value, including canonical and legacy values not known when this
-- migration was written. The sidecar is migration-local state and is dropped
-- by down.
ALTER TABLE issue DROP CONSTRAINT IF EXISTS issue_status_check;

CREATE TABLE issue_status_282_rollback (
    issue_id UUID PRIMARY KEY,
    previous_status TEXT NOT NULL
);

INSERT INTO issue_status_282_rollback (issue_id, previous_status)
SELECT id, status FROM issue;

UPDATE issue
SET status = CASE status
    WHEN 'backlog' THEN 'Spec'
    WHEN 'todo' THEN 'Spec'
    WHEN 'Registered' THEN 'Spec'
    WHEN 'Building' THEN 'in_progress'
    WHEN 'In Progress' THEN 'in_progress'
    WHEN 'QC' THEN 'in_review'
    WHEN 'In Review' THEN 'in_review'
    WHEN 'blocked' THEN 'Human Review'
    WHEN 'Blocked' THEN 'Human Review'
    WHEN 'done' THEN 'Done'
    WHEN 'cancelled' THEN 'Cancelled'
    WHEN 'dead_letter' THEN 'Cancelled'
    -- Unknown pre-up values are intentionally canonicalized to Spec. Their
    -- exact original value is retained in issue_status_282_rollback for down.
    ELSE 'Spec'
END
WHERE status NOT IN
    ('Spec', 'Queue', 'in_progress', 'in_review', 'Human Review', 'Done', 'Cancelled', 'Archived');

ALTER TABLE issue ADD CONSTRAINT issue_status_check CHECK (status IN
    ('Spec', 'Queue', 'in_progress', 'in_review', 'Human Review', 'Done', 'Cancelled', 'Archived'));
