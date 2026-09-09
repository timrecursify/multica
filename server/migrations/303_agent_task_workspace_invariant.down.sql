DROP TRIGGER IF EXISTS agent_task_queue_enforce_workspace_trigger ON agent_task_queue;
DROP FUNCTION IF EXISTS agent_task_queue_enforce_workspace();
ALTER TABLE agent_task_queue DROP COLUMN IF EXISTS workspace_id;
