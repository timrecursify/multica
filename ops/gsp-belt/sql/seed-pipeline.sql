\set ON_ERROR_STOP on

BEGIN;

WITH target_workspace AS (
  SELECT id
  FROM public.workspace
  WHERE slug = 'gsp-multica'
)
INSERT INTO public.workflow_state (
  workspace_id,
  name,
  description,
  color,
  position,
  archived
)
SELECT
  target_workspace.id,
  stage.name,
  stage.description,
  stage.color,
  stage.position,
  false
FROM target_workspace
CROSS JOIN (
  VALUES
    ('Registered', 'Ticket registered for relay intake', '#64748b', 0),
    ('Spec', 'Specification and acceptance criteria', '#0ea5e9', 1),
    ('Queue', 'Ready for automated assignment', '#8b5cf6', 2),
    ('In Progress', 'Implementation is active', '#f59e0b', 3),
    ('In Review', 'Automated quality review', '#ec4899', 4),
    ('Human Review', 'Human approval gate', '#ef4444', 5),
    ('CI/CD & Deploy', 'Build, deploy, and runtime verification', '#14b8a6', 6),
    ('Done', 'Work completed', '#22c55e', 7)
) AS stage(name, description, color, position)
ON CONFLICT (workspace_id, name) DO UPDATE
SET description = EXCLUDED.description,
    color = EXCLUDED.color,
    position = EXCLUDED.position,
    archived = false,
    updated_at = now();

INSERT INTO public.relay_stage_config (
  stage_name,
  next_stage,
  agent_id,
  agent_name,
  alt_next_stages
)
VALUES
  (
    'Registered',
    'Spec',
    '240cceba-1bc0-44b5-b7fd-c85a1492c33b',
    'Codex Luna',
    NULL
  ),
  (
    'Spec',
    'Queue',
    '3d0561a4-dfbd-47cc-ae80-38557a5c746d',
    'Codex Terra',
    ARRAY['CI/CD & Deploy']
  ),
  (
    'Queue',
    'In Progress',
    '3d0561a4-dfbd-47cc-ae80-38557a5c746d',
    'Codex Terra',
    ARRAY['CI/CD & Deploy']
  ),
  (
    'In Progress',
    'In Review',
    '3d0561a4-dfbd-47cc-ae80-38557a5c746d',
    'Codex Terra',
    ARRAY['CI/CD & Deploy']
  ),
  (
    'In Review',
    'Human Review',
    'a9f7b355-66fb-4c3d-97c8-a95fd0362591',
    'Codex Sol',
    NULL
  ),
  (
    'Human Review',
    'CI/CD & Deploy',
    'a9f7b355-66fb-4c3d-97c8-a95fd0362591',
    'Codex Sol',
    NULL
  ),
  (
    'CI/CD & Deploy',
    'Done',
    'a9f7b355-66fb-4c3d-97c8-a95fd0362591',
    'Codex Sol',
    NULL
  ),
  (
    'Done',
    NULL,
    NULL,
    'Terminal stage',
    NULL
  )
ON CONFLICT (stage_name) DO UPDATE
SET next_stage = EXCLUDED.next_stage,
    agent_id = EXCLUDED.agent_id,
    agent_name = EXCLUDED.agent_name,
    alt_next_stages = EXCLUDED.alt_next_stages;

COMMIT;
