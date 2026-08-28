-- PROD-22899 / PPP-22899: bind token accounting to task AND attempt AND
-- runtime so a task's cost is attributable per attempt rather than only in
-- aggregate, and record whether the numbers are provider-reported or locally
-- estimated.
--
-- Previously task_usage was unique per (task_id, provider, model). A task
-- retried across attempts would OVERWRITE the same row (UpsertTaskUsage upserts
-- token counters), so a retried task's per-attempt spend was lost and the
-- "attempt" dimension could never be reconstructed. This migration:
--   1. adds attempt_no so each attempt is a distinct, attributable row;
--   2. adds runtime_id so it is clear which worker ran the attempt;
--   3. adds usage_source so provider-reported usage is never conflated with a
--      local estimate ('provider' | 'estimated'; default 'provider').
ALTER TABLE task_usage
    ADD COLUMN attempt_no integer NOT NULL DEFAULT 1,
    ADD COLUMN runtime_id uuid,
    ADD COLUMN usage_source text NOT NULL DEFAULT 'provider';

-- Backfill runtime_id for existing rows from their task's current runtime so
-- historical cost remains attributable where the runtime is still known.
UPDATE task_usage tu
SET runtime_id = atq.runtime_id
FROM agent_task_queue atq
WHERE atq.id = tu.task_id
  AND tu.runtime_id IS NULL
  AND atq.runtime_id IS NOT NULL;

ALTER TABLE task_usage
    ADD CONSTRAINT ck_task_usage_usage_source
    CHECK (usage_source IN ('provider', 'estimated'));

-- Replace the per-(task, provider, model) uniqueness with an attempt-aware key.
ALTER TABLE task_usage
    DROP CONSTRAINT task_usage_task_id_provider_model_key;
ALTER TABLE task_usage
    ADD CONSTRAINT task_usage_task_id_provider_model_attempt_key
    UNIQUE (task_id, provider, model, attempt_no);
