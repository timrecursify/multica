UPDATE relay_stage_config
SET alt_next_stages = NULLIF(
    array_remove(COALESCE(alt_next_stages, ARRAY[]::text[]), 'Done'),
    ARRAY[]::text[])
WHERE stage_name = 'In Progress'
  AND COALESCE(alt_next_stages, ARRAY[]::text[]) @> ARRAY['Done'];
