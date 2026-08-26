-- Event triggers: fire an autopilot when an issue enters a watched status
-- (PPP-21289). Native intake replaces the poll-based cron dispatcher: an
-- issue entering Queue fires the build-agent autopilot, an issue entering
-- in_review fires the QC autopilot. kind='event' triggers match via
-- event_filters (JSONB) against issue status transitions.
ALTER TABLE autopilot_trigger
    DROP CONSTRAINT IF EXISTS autopilot_trigger_kind_check;
ALTER TABLE autopilot_trigger
    ADD CONSTRAINT autopilot_trigger_kind_check
    CHECK (kind IN ('schedule', 'webhook', 'api', 'event'));

ALTER TABLE autopilot_run
    DROP CONSTRAINT IF EXISTS autopilot_run_source_check;
ALTER TABLE autopilot_run
    ADD CONSTRAINT autopilot_run_source_check
    CHECK (source IN ('schedule', 'manual', 'webhook', 'api', 'event'));

CREATE INDEX IF NOT EXISTS idx_autopilot_trigger_event
    ON autopilot_trigger(autopilot_id)
    WHERE enabled = true AND kind = 'event';
