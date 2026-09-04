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
    WHEN 'Building' THEN 'In Progress'
    WHEN 'in_progress' THEN 'In Progress'
    WHEN 'QC' THEN 'In Review'
    WHEN 'in_review' THEN 'In Review'
    WHEN 'blocked' THEN 'Human Review'
    WHEN 'Blocked' THEN 'Human Review'
    WHEN 'done' THEN 'Done'
    WHEN 'cancelled' THEN 'Cancelled'
    WHEN 'dead_letter' THEN 'Cancelled'
    -- Existing canonical relay statuses (including Registered and CI/CD &
    -- Deploy) fall through unchanged. Parked/Rejected normalize to Spec.
    -- values are intentionally canonicalized to Spec. Their
    -- exact original value is retained in issue_status_282_rollback for down.
    WHEN 'Parked' THEN 'Spec'
    WHEN 'Rejected' THEN 'Spec'
    ELSE 'Spec'
END
WHERE status NOT IN
    ('Registered', 'Spec', 'Queue', 'In Progress', 'In Review',
     'Human Review', 'CI/CD & Deploy', 'Done', 'Archived', 'Cancelled');

ALTER TABLE issue ADD CONSTRAINT issue_status_check CHECK (status IN
    ('Registered', 'Spec', 'Queue', 'In Progress', 'In Review',
     'Human Review', 'CI/CD & Deploy', 'Done', 'Archived', 'Cancelled'));

-- New rows that omit status must also enter the canonical vocabulary.
ALTER TABLE issue ALTER COLUMN status SET DEFAULT 'Spec';
