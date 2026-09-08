-- Held admission is enforced on agent_task_queue and relay_run_log only.
-- A cicd_deploy_attempt trigger used to live here too, but that table
-- exists in no canonical migration, and DROP TRIGGER IF EXISTS still
-- requires its table, so this whole transaction aborted and the fence
-- never installed.
BEGIN;

CREATE TABLE IF NOT EXISTS belt_deployment_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  admission_held boolean NOT NULL DEFAULT false,
  invocation_id text,
  controller_pid bigint,
  controller_start_ticks bigint,
  controller_boot_id text,
  held_at timestamptz,
  released_at timestamptz,
  takeover_of_invocation_id text,
  takeover_at timestamptz
);

ALTER TABLE belt_deployment_control
  ADD COLUMN IF NOT EXISTS controller_start_ticks bigint,
  ADD COLUMN IF NOT EXISTS controller_boot_id text,
  ADD COLUMN IF NOT EXISTS takeover_of_invocation_id text,
  ADD COLUMN IF NOT EXISTS takeover_at timestamptz;

INSERT INTO belt_deployment_control (singleton) VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

CREATE OR REPLACE FUNCTION belt_reject_admission_while_deploying()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM belt_deployment_control
    WHERE singleton AND admission_held
  ) THEN
    IF TG_TABLE_NAME = 'agent_task_queue'
       AND NEW.status IN ('queued', 'dispatched', 'running', 'waiting_local_directory', 'deferred')
       AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
      RAISE EXCEPTION 'belt deployment admission is held' USING ERRCODE = '55000';
    END IF;
    IF TG_TABLE_NAME = 'relay_run_log' AND NEW.status = 'pending'
       AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
      RAISE EXCEPTION 'belt deployment admission is held' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS belt_deployment_admission_hold ON agent_task_queue;
CREATE TRIGGER belt_deployment_admission_hold
BEFORE INSERT OR UPDATE OF status ON agent_task_queue
FOR EACH ROW EXECUTE FUNCTION belt_reject_admission_while_deploying();

DROP TRIGGER IF EXISTS belt_deployment_relay_hold ON relay_run_log;
CREATE TRIGGER belt_deployment_relay_hold
BEFORE INSERT OR UPDATE OF status ON relay_run_log
FOR EACH ROW EXECUTE FUNCTION belt_reject_admission_while_deploying();

COMMIT;
