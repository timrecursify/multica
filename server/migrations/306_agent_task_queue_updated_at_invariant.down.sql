ALTER TABLE agent_task_queue
    DROP CONSTRAINT IF EXISTS agent_task_queue_updated_at_after_started_at;
DROP TRIGGER IF EXISTS agent_task_queue_touch_updated_at ON agent_task_queue;
DROP FUNCTION IF EXISTS agent_task_queue_touch_updated_at();
ALTER TABLE agent_task_queue DROP COLUMN IF EXISTS updated_at;
