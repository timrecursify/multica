UPDATE relay_stage_config
   SET alt_next_stages = array_remove(alt_next_stages, 'Human Review')
 WHERE workspace_id = 'da3c5c5c-a123-4567-b999-c3ed1820da00'::uuid
   AND stage_name = 'CI/CD & Deploy';
