-- Keep task queue mutation time usable for duration and replay analysis.
ALTER TABLE agent_task_queue
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- Existing rows may have been written by deployments that did not maintain a
-- task update timestamp, or may contain a stale value from a replay. Reconcile
-- every row (not only NULLs) before enforcing the invariant so migration also
-- succeeds on databases that already have this column populated.
UPDATE agent_task_queue
SET updated_at = GREATEST(
    COALESCE(updated_at, '-infinity'::timestamptz),
    created_at,
    COALESCE(started_at, '-infinity'::timestamptz),
    COALESCE(completed_at, '-infinity'::timestamptz)
);

ALTER TABLE agent_task_queue
    ALTER COLUMN updated_at SET DEFAULT now(),
    ALTER COLUMN updated_at SET NOT NULL;

CREATE OR REPLACE FUNCTION agent_task_queue_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    mutation_at timestamptz := clock_timestamp();
BEGIN
    IF TG_OP = 'UPDATE' THEN
        mutation_at := GREATEST(mutation_at, COALESCE(OLD.updated_at, '-infinity'::timestamptz));
    END IF;

    NEW.updated_at := GREATEST(
        mutation_at,
        COALESCE(NEW.started_at, '-infinity'::timestamptz),
        COALESCE(NEW.completed_at, '-infinity'::timestamptz)
    );
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_task_queue_touch_updated_at ON agent_task_queue;
CREATE TRIGGER agent_task_queue_touch_updated_at
    BEFORE INSERT OR UPDATE ON agent_task_queue
    FOR EACH ROW
    EXECUTE FUNCTION agent_task_queue_touch_updated_at();

ALTER TABLE agent_task_queue
    ADD CONSTRAINT agent_task_queue_updated_at_after_started_at
    CHECK (started_at IS NULL OR updated_at >= started_at);
