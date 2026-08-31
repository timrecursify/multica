-- Add explicit non-execution dispositions. Human Review remains reserved for
-- money/auth/approval decisions; Parked and Rejected must not alias to it.
ALTER TABLE issue DROP CONSTRAINT IF EXISTS issue_status_check;

ALTER TABLE issue ADD CONSTRAINT issue_status_check CHECK (status IN
    ('Registered', 'Spec', 'Queue', 'In Progress', 'In Review',
     'Human Review', 'Parked', 'Rejected', 'CI/CD & Deploy', 'Done',
     'Archived', 'Cancelled'));
