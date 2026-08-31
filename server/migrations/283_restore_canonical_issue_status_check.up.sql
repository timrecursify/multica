-- Restore the production relay vocabulary without rewriting existing issues.
-- 282 is not applied in production, so this migration deliberately repairs
-- only the schema contract. The write trigger preserves compatibility for
-- older clients while storing the canonical relay spelling.
ALTER TABLE issue DROP CONSTRAINT IF EXISTS issue_status_check;

CREATE OR REPLACE FUNCTION normalize_issue_status_before_write()
RETURNS TRIGGER AS $$
BEGIN
    NEW.status := CASE NEW.status
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
        ELSE NEW.status
    END;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS issue_status_normalize_before_write ON issue;
CREATE TRIGGER issue_status_normalize_before_write
BEFORE INSERT OR UPDATE OF status ON issue
FOR EACH ROW EXECUTE FUNCTION normalize_issue_status_before_write();

ALTER TABLE issue ADD CONSTRAINT issue_status_check CHECK (status IN
    ('Registered', 'Spec', 'Queue', 'In Progress', 'In Review',
     'Human Review', 'CI/CD & Deploy', 'Done', 'Archived', 'Cancelled'));

ALTER TABLE issue ALTER COLUMN status SET DEFAULT 'Spec';
