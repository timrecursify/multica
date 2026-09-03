-- Make workspace ownership durable for every task.  The agent is the
-- authoritative owner for quick-create and source-less rows; linked sources
-- and runtimes must agree while a task is active.
ALTER TABLE agent_task_queue
  ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspace(id) ON DELETE SET NULL;

-- Backfill only from the authoritative agent relation.  Rows whose agent was
-- deleted (legacy terminal history) intentionally remain source-less.
UPDATE agent_task_queue t
SET workspace_id = a.workspace_id
FROM agent a
WHERE a.id = t.agent_id AND t.workspace_id IS NULL;

UPDATE agent_task_queue t SET workspace_id = i.workspace_id
FROM issue i WHERE t.issue_id = i.id AND t.workspace_id IS NULL;
UPDATE agent_task_queue t SET workspace_id = c.workspace_id
FROM chat_session c WHERE t.chat_session_id = c.id AND t.workspace_id IS NULL;
UPDATE agent_task_queue t SET workspace_id = ap.workspace_id
FROM autopilot_run ar JOIN autopilot ap ON ap.id = ar.autopilot_id
WHERE t.autopilot_run_id = ar.id AND t.workspace_id IS NULL;

-- Do not leave already-poisoned active rows claimable when the invariant is
-- installed.  They are preserved for audit, but can no longer be dispatched.
UPDATE agent_task_queue t
SET status = 'cancelled', completed_at = COALESCE(completed_at, now()),
    error = COALESCE(error, 'workspace ownership mismatch'),
    failure_reason = COALESCE(failure_reason, 'workspace_mismatch'),
    prepare_lease_expires_at = NULL
FROM agent a
WHERE a.id = t.agent_id
  AND t.status IN ('queued','deferred','dispatched','running','waiting_local_directory')
  AND (t.workspace_id IS DISTINCT FROM a.workspace_id
       OR EXISTS (SELECT 1 FROM agent_runtime r
                  WHERE r.id = t.runtime_id AND r.workspace_id IS DISTINCT FROM a.workspace_id)
       OR EXISTS (SELECT 1 FROM issue i
                  WHERE i.id = t.issue_id AND i.workspace_id IS DISTINCT FROM a.workspace_id)
       OR EXISTS (SELECT 1 FROM chat_session c
                  WHERE c.id = t.chat_session_id AND c.workspace_id IS DISTINCT FROM a.workspace_id)
       OR EXISTS (SELECT 1 FROM autopilot_run ar JOIN autopilot ap ON ap.id = ar.autopilot_id
                  WHERE ar.id = t.autopilot_run_id AND ap.workspace_id IS DISTINCT FROM a.workspace_id));

CREATE OR REPLACE FUNCTION agent_task_queue_enforce_workspace()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_ws uuid;
BEGIN
  SELECT workspace_id INTO owner_ws FROM agent WHERE id = NEW.agent_id;
  -- Deleted-agent legacy history is allowed to remain untouched.
  IF owner_ws IS NULL THEN RETURN NEW; END IF;
  IF NEW.workspace_id IS NOT NULL AND NEW.workspace_id IS DISTINCT FROM owner_ws THEN
    RAISE EXCEPTION 'agent task workspace invariant violated: task workspace differs from agent workspace';
  END IF;
  NEW.workspace_id := owner_ws;
  IF NEW.status NOT IN ('queued','deferred','dispatched','running','waiting_local_directory') THEN
    RETURN NEW;
  END IF;
  IF NEW.runtime_id IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM agent_runtime r WHERE r.id = NEW.runtime_id AND r.workspace_id = owner_ws) THEN
    RAISE EXCEPTION 'agent task workspace invariant violated: runtime workspace differs from agent workspace';
  END IF;
  IF NEW.issue_id IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM issue i WHERE i.id = NEW.issue_id AND i.workspace_id = owner_ws) THEN
    RAISE EXCEPTION 'agent task workspace invariant violated: issue workspace differs from agent workspace';
  END IF;
  IF NEW.chat_session_id IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM chat_session c WHERE c.id = NEW.chat_session_id AND c.workspace_id = owner_ws) THEN
    RAISE EXCEPTION 'agent task workspace invariant violated: chat workspace differs from agent workspace';
  END IF;
  IF NEW.autopilot_run_id IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM autopilot_run ar JOIN autopilot ap ON ap.id = ar.autopilot_id
       WHERE ar.id = NEW.autopilot_run_id AND ap.workspace_id = owner_ws) THEN
    RAISE EXCEPTION 'agent task workspace invariant violated: autopilot workspace differs from agent workspace';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS agent_task_queue_enforce_workspace_trigger ON agent_task_queue;
CREATE TRIGGER agent_task_queue_enforce_workspace_trigger
BEFORE INSERT OR UPDATE OF agent_id, runtime_id, issue_id, chat_session_id,
  autopilot_run_id, status, workspace_id ON agent_task_queue
FOR EACH ROW EXECUTE FUNCTION agent_task_queue_enforce_workspace();

CREATE INDEX IF NOT EXISTS idx_agent_task_queue_workspace_status
  ON agent_task_queue (workspace_id, status);
