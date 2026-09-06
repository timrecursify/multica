ALTER TABLE agent_task_queue
  DROP COLUMN IF EXISTS relay_retired_reason,
  DROP COLUMN IF EXISTS relay_retired_at;
