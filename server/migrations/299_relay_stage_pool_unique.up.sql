CREATE UNIQUE INDEX CONCURRENTLY relay_stage_pool_workspace_stage_key
    ON relay_stage_pool (workspace_id, stage_name);
