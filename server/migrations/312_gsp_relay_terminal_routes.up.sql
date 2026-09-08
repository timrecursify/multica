-- Align the GSP graph with transition-policy and the daemon's capped-work routes.
-- Idempotent and scoped to GSP; preserve existing destination order.
UPDATE relay_stage_config
SET alt_next_stages = array_append(COALESCE(alt_next_stages, ARRAY[]::text[]), 'Spec')
WHERE workspace_id = 'f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f'::uuid
  AND stage_name = 'In Progress'
  AND NOT ('Spec' = ANY(COALESCE(alt_next_stages, ARRAY[]::text[])));

UPDATE relay_stage_config
SET alt_next_stages = array_append(COALESCE(alt_next_stages, ARRAY[]::text[]), 'Human Review')
WHERE workspace_id = 'f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f'::uuid
  AND stage_name IN ('Queue', 'In Progress', 'CI/CD & Deploy')
  AND NOT ('Human Review' = ANY(COALESCE(alt_next_stages, ARRAY[]::text[])));
