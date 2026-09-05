ALTER TABLE issue DROP CONSTRAINT IF EXISTS issue_status_check;
UPDATE issue SET status = 'Human Review' WHERE status = 'Blocked (human)';
ALTER TABLE issue ADD CONSTRAINT issue_status_check CHECK (status IN
    ('Registered', 'Spec', 'Queue', 'In Progress', 'In Review',
     'Human Review', 'CI/CD & Deploy', 'Done', 'Archived', 'Cancelled'));
