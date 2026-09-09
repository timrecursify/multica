ALTER TABLE issue
    DROP CONSTRAINT IF EXISTS issue_status_check,
    ADD CONSTRAINT issue_status_check CHECK (status IN
    ('Registered', 'Spec', 'Queue', 'In Progress', 'In Review',
     'Human Review', 'Parked', 'Rejected', 'CI/CD & Deploy', 'Done',
     'Archived', 'Cancelled'));
