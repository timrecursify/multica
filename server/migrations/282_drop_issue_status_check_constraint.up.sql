-- PPP-22989: converge issue.status storage on the production board vocabulary.
-- The rollback table records each changed row's exact previous spelling.
CREATE TABLE issue_status_282_rollback (
    issue_id UUID PRIMARY KEY,
    previous_status TEXT NOT NULL
);

INSERT INTO issue_status_282_rollback (issue_id, previous_status)
SELECT id, status FROM issue
WHERE status IN ('backlog', 'todo', 'Registered', 'Building', 'In Progress', 'QC',
    'In Review', 'blocked', 'Blocked', 'done', 'cancelled', 'dead_letter');

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
    ELSE status
END;

-- Fail closed: every stored status must be readable and writable by the
-- canonical handler after this migration.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM issue WHERE status NOT IN
        ('Spec', 'Queue', 'in_progress', 'in_review', 'Human Review', 'Done', 'Cancelled', 'Archived')) THEN
        RAISE EXCEPTION 'PPP-22989: issue.status contains an unknown value after canonicalization';
    END IF;
END $$;

ALTER TABLE issue DROP CONSTRAINT IF EXISTS issue_status_check;
ALTER TABLE issue ADD CONSTRAINT issue_status_check CHECK (status IN
    ('Spec', 'Queue', 'in_progress', 'in_review', 'Human Review', 'Done', 'Cancelled', 'Archived'));
