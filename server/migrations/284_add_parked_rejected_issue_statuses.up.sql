-- Add explicit non-execution dispositions. Human Review remains reserved for
-- money/auth/approval decisions; Parked and Rejected must not alias to it.
ALTER TABLE issue DROP CONSTRAINT IF EXISTS issue_status_check;

ALTER TABLE issue ADD CONSTRAINT issue_status_check CHECK (status IN
    ('Registered', 'Spec', 'Queue', 'In Progress', 'In Review',
     'Human Review', 'CI/CD & Deploy', 'Done', 'Archived', 'Cancelled'));

-- relay_run_log is an operator-side belt table and is not present in every
-- canonical Multica installation. Extend it where installed without making a
-- clean application schema unable to migrate.
DO $$
BEGIN
    IF to_regclass('public.relay_run_log') IS NOT NULL THEN
        EXECUTE 'ALTER TABLE relay_run_log DROP CONSTRAINT IF EXISTS relay_run_log_status_check';
        EXECUTE 'ALTER TABLE relay_run_log ADD CONSTRAINT relay_run_log_status_check '
             || 'CHECK (status IN (''pending'', ''completed'', ''failed'', ''rejected''))';
    END IF;
END;
$$;
