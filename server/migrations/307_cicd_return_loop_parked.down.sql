UPDATE relay_stage_config
SET alt_next_stages = array_remove(alt_next_stages, 'Parked')
WHERE stage_name = 'CI/CD & Deploy';
