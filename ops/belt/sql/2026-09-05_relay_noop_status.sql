DO $$
BEGIN
  IF to_regclass('public.relay_run_log') IS NOT NULL THEN
    ALTER TABLE public.relay_run_log DROP CONSTRAINT IF EXISTS relay_run_log_status_check;
    ALTER TABLE public.relay_run_log ADD CONSTRAINT relay_run_log_status_check
      CHECK (status IN ('pending', 'completed', 'failed', 'noop'));
  END IF;
END $$;
