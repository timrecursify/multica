-- Restore enqueue deduplication for pending issue tasks. This must remain one
-- concurrent statement so a live repair does not block the queue.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_one_pending_task_per_issue_agent_v2
    ON agent_task_queue (issue_id, agent_id)
    WHERE status IN ('queued', 'dispatched')
       OR (status = 'deferred' AND context->>'channel_issue_media_pending' = 'true');
