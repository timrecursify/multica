UPDATE relay_stage_config
SET alt_next_stages = NULL
WHERE stage_name IN ('Spec', 'Queue', 'In Progress');
