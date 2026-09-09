DROP INDEX IF EXISTS idx_agent_task_queue_workspace_status;
DROP TRIGGER IF EXISTS agent_task_queue_enforce_workspace_trigger ON agent_task_queue;
DROP FUNCTION IF EXISTS agent_task_queue_enforce_workspace();
