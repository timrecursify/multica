UPDATE relay_stage_config
SET alt_next_stages = NULLIF(array_remove(COALESCE(alt_next_stages, ARRAY[]::text[]), 'Spec'), ARRAY[]::text[])
WHERE workspace_id = 'f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f'::uuid AND stage_name = 'In Progress';

UPDATE relay_stage_config
SET alt_next_stages = NULLIF(array_remove(COALESCE(alt_next_stages, ARRAY[]::text[]), 'Human Review'), ARRAY[]::text[])
WHERE workspace_id = 'f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f'::uuid
  AND stage_name IN ('Queue', 'In Progress', 'CI/CD & Deploy');
