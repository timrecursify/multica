-- Capture issue.qc_fail_count in the migration-derived schema.
--
-- The column is live in the production Multica database but was absent from
-- every migration. The QC rework circuit breaker in the PPP runtime
-- (multica-qc-worker.cjs, multica-judge-worker.cjs) reads and increments the
-- counter, so the drift is captured rather than dropped. Production DDL for
-- the column is `integer NULL DEFAULT 0`; the workers already treat NULL as
-- 0 (COALESCE), so the column stays nullable to match prod exactly.
ALTER TABLE issue
    ADD COLUMN IF NOT EXISTS qc_fail_count integer DEFAULT 0;
