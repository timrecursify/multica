-- Rollback is fail-closed: do not silently rewrite a disposition. Operators
-- must explicitly clear Parked/Rejected rows before removing the vocabulary.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM issue WHERE status IN ('Parked', 'Rejected')) THEN
        RAISE EXCEPTION 'cannot remove Parked/Rejected while issues use those statuses';
    END IF;
END;
$$;

ALTER TABLE issue DROP CONSTRAINT IF EXISTS issue_status_check;

ALTER TABLE issue ADD CONSTRAINT issue_status_check CHECK (status IN
    ('Registered', 'Spec', 'Queue', 'In Progress', 'In Review',
     'Human Review', 'CI/CD & Deploy', 'Done', 'Archived', 'Cancelled'));

DO $$
BEGIN
    IF to_regclass('public.relay_run_log') IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM relay_run_log WHERE status = 'rejected') THEN
            RAISE EXCEPTION 'cannot remove Rejected relay logs while rows use that status';
        END IF;
        EXECUTE 'ALTER TABLE relay_run_log DROP CONSTRAINT IF EXISTS relay_run_log_status_check';
        EXECUTE 'ALTER TABLE relay_run_log ADD CONSTRAINT relay_run_log_status_check '
             || 'CHECK (status IN (''pending'', ''completed'', ''failed''))';
    END IF;
END;
$$;
