-- Return to migration 282's stored vocabulary. The 282 rollback sidecar is
-- intentionally retained so 282's own down migration can restore originals.
ALTER TABLE issue DROP CONSTRAINT IF EXISTS issue_status_check;

UPDATE issue
SET status = CASE status
    WHEN 'Registered' THEN 'Spec'
    WHEN 'CI/CD & Deploy' THEN 'Spec'
    WHEN 'In Progress' THEN 'in_progress'
    WHEN 'In Review' THEN 'in_review'
    ELSE status
END
WHERE status IN ('Registered', 'CI/CD & Deploy', 'In Progress', 'In Review');

ALTER TABLE issue ADD CONSTRAINT issue_status_check CHECK (status IN
    ('Spec', 'Queue', 'in_progress', 'in_review',
     'Human Review', 'Done', 'Cancelled', 'Archived'));

ALTER TABLE issue ALTER COLUMN status SET DEFAULT 'Spec';
