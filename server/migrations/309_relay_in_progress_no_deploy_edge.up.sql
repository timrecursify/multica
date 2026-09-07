UPDATE relay_stage_config
SET alt_next_stages = ARRAY['Done'] ||
    array_remove(COALESCE(alt_next_stages, ARRAY[]::text[]), 'Done')
WHERE stage_name = 'In Progress'
  AND NOT (COALESCE(alt_next_stages, ARRAY[]::text[]) @> ARRAY['Done']);
