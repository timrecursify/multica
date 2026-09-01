-- A Parked issue can re-enter only through the bridge's explicit one-use
-- release marker. The route is durable; admission remains fail-closed.
INSERT INTO relay_stage_config (id, stage_name, next_stage)
VALUES (11, 'Parked', 'Queue')
ON CONFLICT DO NOTHING;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM relay_stage_config
        WHERE id = 11 AND stage_name = 'Parked' AND next_stage = 'Queue'
    ) THEN
        RAISE EXCEPTION 'relay stage id 11 is not the Parked to Queue release route';
    END IF;
END;
$$;
