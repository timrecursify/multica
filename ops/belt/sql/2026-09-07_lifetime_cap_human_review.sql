-- The lifetime paid-task cap is the only automatic Spec edge added here.
-- Human Review remains unavailable to ordinary stage routing.
UPDATE public.relay_stage_config
SET alt_next_stages = array_append(COALESCE(alt_next_stages, '{}'::text[]), 'Human Review')
WHERE stage_name = 'Spec'
  AND NOT ('Human Review' = ANY(COALESCE(alt_next_stages, '{}'::text[])));
