-- Reverse 277_agent_task_queue_issue_id_nullable.up.sql.
--
-- Restore the NOT NULL invariant on agent_task_queue.issue_id. Any remaining
-- issue-less rows (chat / run_only autopilot tasks) must be cleared first,
-- mirroring 033_chat.down.sql; run this only after those paths stop writing
-- NULL issue_id.
DELETE FROM agent_task_queue WHERE issue_id IS NULL;
ALTER TABLE agent_task_queue
    ALTER COLUMN issue_id SET NOT NULL;
