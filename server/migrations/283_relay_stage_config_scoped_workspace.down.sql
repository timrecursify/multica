-- Reverse the relay_run_log ledger and the workspace-scoped relay configuration.
DROP TABLE IF EXISTS relay_run_log;

DROP INDEX IF EXISTS relay_stage_config_workspace_stage_key;

ALTER TABLE relay_stage_config
    DROP CONSTRAINT IF EXISTS relay_stage_config_agent_id_fkey;

ALTER TABLE relay_stage_config
    DROP CONSTRAINT IF EXISTS relay_stage_config_workspace_id_fkey;

ALTER TABLE relay_stage_config
    DROP COLUMN IF EXISTS workspace_id,
    DROP COLUMN IF EXISTS agent_id,
    DROP COLUMN IF EXISTS agent_name,
    DROP COLUMN IF EXISTS alt_next_stages,
    DROP COLUMN IF EXISTS created_at;

-- Restore the global single-row-per-stage invariant for the migration 279 default.
ALTER TABLE relay_stage_config
    ADD UNIQUE (stage_name);
