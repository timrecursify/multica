ALTER TABLE agent_task_queue
  ADD COLUMN IF NOT EXISTS relay_retired_at timestamptz,
  ADD COLUMN IF NOT EXISTS relay_retired_reason text;
