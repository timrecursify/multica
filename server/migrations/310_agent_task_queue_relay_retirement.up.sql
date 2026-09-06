ALTER TABLE agent_task_queue
  ADD COLUMN IF NOT EXISTS relay_retired_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS relay_retired_reason TEXT NULL;
