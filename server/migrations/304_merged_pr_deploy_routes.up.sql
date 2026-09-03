-- Permit authenticated merged-PR recovery to bypass paid build stages.
UPDATE relay_stage_config
SET alt_next_stages = CASE
  WHEN 'CI/CD & Deploy' = ANY(COALESCE(alt_next_stages, ARRAY[]::text[])) THEN alt_next_stages
  ELSE array_append(COALESCE(alt_next_stages, ARRAY[]::text[]), 'CI/CD & Deploy')
END
WHERE stage_name IN ('Spec', 'Queue', 'In Progress');
