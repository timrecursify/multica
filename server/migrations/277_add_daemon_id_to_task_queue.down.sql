-- Rollback: remove daemon_id column and index.
DROP INDEX idx_agent_task_queue_daemon_id;
ALTER TABLE agent_task_queue
DROP COLUMN daemon_id;
