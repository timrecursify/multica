-- Reconcile the production migration ledger collision where historical
-- migration 284 was a different build-budget change. The Parked/Rejected
-- contract is already deployed on some boards, so repeat the additive DDL
-- under a new immutable version instead of rewriting migration history.
ALTER TABLE issue DROP CONSTRAINT IF EXISTS issue_status_check;

UPDATE issue SET status = 'Spec' WHERE status IN ('Parked', 'Rejected');

ALTER TABLE issue ADD CONSTRAINT issue_status_check CHECK (status IN
    ('Registered', 'Spec', 'Queue', 'In Progress', 'In Review',
     'Human Review', 'CI/CD & Deploy', 'Done', 'Archived', 'Cancelled'));

-- relay_run_log is an operator-side belt table and is optional in canonical
-- Multica installs. Reconcile it only where it exists.
DO $$
BEGIN
    IF to_regclass('public.relay_run_log') IS NOT NULL THEN
        EXECUTE 'ALTER TABLE relay_run_log DROP CONSTRAINT IF EXISTS relay_run_log_status_check';
        EXECUTE 'ALTER TABLE relay_run_log ADD CONSTRAINT relay_run_log_status_check '
             || 'CHECK (status IN (''pending'', ''completed'', ''failed'', ''rejected''))';
    END IF;
END;
$$;
