-- Add daemon_id column to agent_task_queue for Scoping-stage task routing.
-- daemon_id = NULL means the task can be claimed by any daemon (backward compatible).
-- daemon_id = 'ppp-free-nvidia' means only that daemon can claim it (task lane isolation).
-- This supports multi-lane routing: junior models (ppp-free-nvidia) vs senior models (ppp-prod-codex).

ALTER TABLE agent_task_queue
ADD COLUMN daemon_id TEXT;

-- Create partial index for daemon-specific task lookups (efficient filtering).
CREATE INDEX idx_agent_task_queue_daemon_id ON agent_task_queue(daemon_id)
WHERE daemon_id IS NOT NULL;
