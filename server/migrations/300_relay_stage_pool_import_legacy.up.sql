-- Existing pool-only rows predate the policy table and must remain live.
INSERT INTO relay_stage_pool (workspace_id, stage_name, enabled)
SELECT workspace_id, stage_name, true
  FROM relay_stage_agent_pool
 GROUP BY workspace_id, stage_name
ON CONFLICT (workspace_id, stage_name) DO NOTHING;

-- Import every existing legacy binding.  A missing agent is deliberately
-- retained as legacy_agent_id so readback can report it as dangling.
INSERT INTO relay_stage_pool (workspace_id, stage_name, enabled, legacy_agent_id)
SELECT workspace_id, stage_name, true, agent_id
  FROM relay_stage_config
 WHERE agent_id IS NOT NULL
ON CONFLICT (workspace_id, stage_name) DO UPDATE
    SET legacy_agent_id = EXCLUDED.legacy_agent_id,
        updated_at = now();

-- Import only valid legacy owners as initial pool members.  Invalid legacy
-- owners remain visible through relay_stage_pool.legacy_agent_id.
INSERT INTO relay_stage_agent_pool (workspace_id, stage_name, agent_id, enabled)
SELECT c.workspace_id, c.stage_name, c.agent_id, true
  FROM relay_stage_config c
  JOIN agent a ON a.id = c.agent_id
             AND a.workspace_id = c.workspace_id
             AND a.archived_at IS NULL
 WHERE c.agent_id IS NOT NULL
ON CONFLICT DO NOTHING;
