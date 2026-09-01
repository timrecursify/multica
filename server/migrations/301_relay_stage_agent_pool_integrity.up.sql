ALTER TABLE relay_stage_agent_pool
    ADD COLUMN IF NOT EXISTS last_selected_at timestamptz;

CREATE OR REPLACE FUNCTION relay_stage_agent_pool_validate_member()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM agent
         WHERE id = NEW.agent_id
           AND workspace_id = NEW.workspace_id
           AND archived_at IS NULL
    ) THEN
        RAISE EXCEPTION 'relay pool member must be a live agent in the same workspace';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS relay_stage_agent_pool_validate_member_trigger
    ON relay_stage_agent_pool;
CREATE TRIGGER relay_stage_agent_pool_validate_member_trigger
    BEFORE INSERT OR UPDATE OF workspace_id, agent_id ON relay_stage_agent_pool
    FOR EACH ROW EXECUTE FUNCTION relay_stage_agent_pool_validate_member();
