DROP INDEX IF EXISTS idx_autopilot_trigger_event;

ALTER TABLE autopilot_run
    DROP CONSTRAINT IF EXISTS autopilot_run_source_check;
ALTER TABLE autopilot_run
    ADD CONSTRAINT autopilot_run_source_check
    CHECK (source IN ('schedule', 'manual', 'webhook', 'api'));

ALTER TABLE autopilot_trigger
    DROP CONSTRAINT IF EXISTS autopilot_trigger_kind_check;
ALTER TABLE autopilot_trigger
    ADD CONSTRAINT autopilot_trigger_kind_check
    CHECK (kind IN ('schedule', 'webhook', 'api'));
