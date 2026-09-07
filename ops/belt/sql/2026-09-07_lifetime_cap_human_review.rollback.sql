UPDATE public.relay_stage_config
SET alt_next_stages = array_remove(alt_next_stages, 'Human Review')
WHERE stage_name = 'Spec';
