UPDATE relay_stage_config
SET alt_next_stages = ARRAY(SELECT DISTINCT unnest(COALESCE(alt_next_stages, ARRAY[]::text[]) || ARRAY['Parked']))
WHERE stage_name = 'CI/CD & Deploy';
