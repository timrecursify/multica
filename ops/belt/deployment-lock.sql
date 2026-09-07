BEGIN;

CREATE TABLE IF NOT EXISTS belt_deployment_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  admission_held boolean NOT NULL DEFAULT false,
  invocation_id text,
  controller_pid bigint,
  held_at timestamptz,
  released_at timestamptz
);

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
    IF TG_TABLE_NAME = 'cicd_deploy_attempt' AND NEW.status = 'running'
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

DROP TRIGGER IF EXISTS belt_deployment_cicd_hold ON cicd_deploy_attempt;
CREATE TRIGGER belt_deployment_cicd_hold
BEFORE INSERT OR UPDATE OF status ON cicd_deploy_attempt
FOR EACH ROW EXECUTE FUNCTION belt_reject_admission_while_deploying();

COMMIT;
