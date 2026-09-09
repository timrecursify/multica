DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM issue WHERE status IN ('Parked', 'Rejected')) THEN
        RAISE EXCEPTION 'refusing rollback: issue rows still use Parked or Rejected';
    END IF;
END;
$$;

ALTER TABLE issue DROP CONSTRAINT IF EXISTS issue_status_check;
ALTER TABLE issue ADD CONSTRAINT issue_status_check CHECK (status IN
    ('Registered', 'Spec', 'Queue', 'In Progress', 'In Review',
     'Human Review', 'CI/CD & Deploy', 'Done', 'Archived', 'Cancelled'));
