-- Distinguish work that is stopped for an explicit human decision from the
-- ordinary Human Review workflow. This status is terminal for belt routing,
-- but is intentionally not counted as successful/done work.
ALTER TABLE issue DROP CONSTRAINT IF EXISTS issue_status_check;
ALTER TABLE issue ADD CONSTRAINT issue_status_check CHECK (status IN
    ('Registered', 'Spec', 'Queue', 'In Progress', 'In Review',
     'Human Review', 'Blocked (human)', 'CI/CD & Deploy', 'Done',
     'Archived', 'Cancelled'));
