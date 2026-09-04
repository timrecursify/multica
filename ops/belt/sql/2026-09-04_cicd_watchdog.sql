-- Durable watchdog timestamps for CI/CD deploy attempts.
ALTER TABLE public.cicd_deploy_attempt
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;

UPDATE public.cicd_deploy_attempt
SET started_at = COALESCE(started_at, updated_at),
    last_attempt_at = COALESCE(last_attempt_at, updated_at)
WHERE started_at IS NULL OR last_attempt_at IS NULL;
