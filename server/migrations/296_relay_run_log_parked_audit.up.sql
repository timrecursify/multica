-- The relay log is an optional belt table. Parked entries need their own
-- immutable trigger context without changing the retry or stage contracts.
DO $$
BEGIN
    IF to_regclass('public.relay_run_log') IS NOT NULL THEN
        ALTER TABLE relay_run_log
            ADD COLUMN IF NOT EXISTS parked_audit JSONB;
    END IF;
END;
$$;
