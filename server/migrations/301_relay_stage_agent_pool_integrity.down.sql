DROP TRIGGER IF EXISTS relay_stage_agent_pool_validate_member_trigger
    ON relay_stage_agent_pool;
DROP FUNCTION IF EXISTS relay_stage_agent_pool_validate_member();
ALTER TABLE relay_stage_agent_pool DROP COLUMN IF EXISTS last_selected_at;
