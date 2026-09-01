-- Keep explicit workspace seed IDs from colliding with the serial default.
-- Never rewind a sequence that an operator has already advanced. When the
-- table is non-empty, an at-or-behind value is made called at MAX(id), so the
-- next default insert is MAX(id) + 1. Empty tables retain their sequence
-- state and therefore keep the normal nextval behavior.
DO $$
DECLARE
    sequence_name regclass := pg_get_serial_sequence('relay_stage_config', 'id');
    sequence_last_value bigint;
    sequence_is_called boolean;
    highest_id bigint;
BEGIN
    SELECT MAX(id) INTO highest_id FROM relay_stage_config;
    IF highest_id IS NULL OR sequence_name IS NULL THEN
        RETURN;
    END IF;

    EXECUTE format('SELECT last_value, is_called FROM %s', sequence_name)
      INTO sequence_last_value, sequence_is_called;

    IF (sequence_is_called AND sequence_last_value >= highest_id)
       OR (NOT sequence_is_called AND sequence_last_value > highest_id) THEN
        RETURN;
    END IF;

    PERFORM setval(sequence_name, highest_id, true);
END;
$$;

UPDATE relay_stage_config
SET agent_name = 'multica-archiver'
WHERE workspace_id = 'f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f'::uuid
  AND id = 8
  AND stage_name = 'Done'
  AND agent_id IS NULL;
