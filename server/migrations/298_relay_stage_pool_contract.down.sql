ALTER TABLE agent_task_queue DROP COLUMN IF EXISTS relay_pool_stage;
ALTER TABLE agent_task_queue DROP COLUMN IF EXISTS relay_pool_id;
DROP TRIGGER IF EXISTS relay_stage_pool_enabled_requires_member ON relay_stage_pool;
DROP TRIGGER IF EXISTS relay_stage_pool_members_required ON relay_stage_agent_pool;
DROP TRIGGER IF EXISTS relay_stage_pool_agent_liveness ON agent;
DROP FUNCTION IF EXISTS relay_stage_pool_require_member();
ALTER TABLE relay_stage_agent_pool DROP CONSTRAINT IF EXISTS relay_stage_agent_pool_pool_id_fkey;
ALTER TABLE relay_stage_agent_pool DROP COLUMN IF EXISTS pool_id;
DROP TABLE IF EXISTS relay_stage_pool;
