-- Enabled relay-stage pool members must be invocable by workspace actors.
UPDATE agent a
   SET permission_mode = 'public_to', visibility = 'workspace'
 WHERE EXISTS (
   SELECT 1 FROM relay_stage_agent_pool p
    WHERE p.agent_id = a.id
      AND p.workspace_id = a.workspace_id
       AND p.enabled
 )
   AND a.archived_at IS NULL;

INSERT INTO agent_invocation_target (agent_id, target_type, target_id, created_by)
SELECT DISTINCT a.id, 'workspace', a.workspace_id, NULL
  FROM agent a
  JOIN relay_stage_agent_pool p
    ON p.agent_id = a.id
   AND p.workspace_id = a.workspace_id
   AND p.enabled
 WHERE a.archived_at IS NULL
 ON CONFLICT (agent_id, target_type, target_id) DO NOTHING;
