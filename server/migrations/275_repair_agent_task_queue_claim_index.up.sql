-- Keep daemon polling on the normal queue-claim access path after migration
-- 274 recreates a missing table. This must remain one concurrent statement.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_task_queue_claim_candidates
    ON agent_task_queue (runtime_id, priority DESC, created_at ASC)
    WHERE status = 'queued';
