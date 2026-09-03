DO $$
BEGIN
    IF to_regclass('public.relay_run_log') IS NOT NULL THEN
        ALTER TABLE relay_run_log
            DROP COLUMN IF EXISTS parked_audit;
    END IF;
END;
$$;
