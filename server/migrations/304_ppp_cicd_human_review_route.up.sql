UPDATE relay_stage_config
   SET alt_next_stages = array_append(COALESCE(alt_next_stages, ARRAY[]::text[]), 'Human Review')
 WHERE workspace_id = 'da3c5c5c-a123-4567-b999-c3ed1820da00'::uuid
   AND stage_name = 'CI/CD & Deploy'
   AND NOT ('Human Review' = ANY(COALESCE(alt_next_stages, ARRAY[]::text[])));
