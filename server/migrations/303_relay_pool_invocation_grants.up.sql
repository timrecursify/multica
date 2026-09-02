-- Enabled relay pool members must be invocable by workspace users and
-- workspace-internal agent/system dispatch.  The target table's unique key
-- makes this safe to run repeatedly.
UPDATE agent a
   SET permission_mode = 'public_to'
 WHERE a.archived_at IS NULL
   AND EXISTS (
       SELECT 1
         FROM relay_stage_agent_pool m
        WHERE m.agent_id = a.id
          AND m.workspace_id = a.workspace_id
          AND m.enabled
   );

INSERT INTO agent_invocation_target (agent_id, target_type, target_id)
SELECT a.id, 'workspace', a.workspace_id
  FROM agent a
 WHERE a.archived_at IS NULL
   AND EXISTS (
       SELECT 1
         FROM relay_stage_agent_pool m
        WHERE m.agent_id = a.id
          AND m.workspace_id = a.workspace_id
          AND m.enabled
   )
ON CONFLICT (agent_id, target_type, target_id) DO NOTHING;
