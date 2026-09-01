-- A task is executed with its agent's workspace credentials. Persist that
-- workspace on every row and reject active rows that resolve to another
-- tenant through a runtime or task source.  The value is deliberately kept on
-- terminal rows: source/runtime cleanup must not make historical tasks invalid.
ALTER TABLE agent_task_queue
    ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspace(id) ON DELETE CASCADE;

UPDATE agent_task_queue task
SET workspace_id = agent.workspace_id
FROM agent
WHERE agent.id = task.agent_id
  AND task.workspace_id IS NULL;

ALTER TABLE agent_task_queue
    ALTER COLUMN workspace_id SET NOT NULL;

CREATE OR REPLACE FUNCTION agent_task_queue_enforce_workspace()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    agent_workspace UUID;
    source_workspace UUID;
BEGIN
    SELECT workspace_id INTO agent_workspace FROM agent WHERE id = NEW.agent_id;
    IF agent_workspace IS NULL THEN
        RAISE EXCEPTION 'agent task workspace invariant violated: agent workspace is missing';
    END IF;

    -- The agent is authoritative for task-owned workspace_id. This also
    -- backstops legacy enqueue callers while preserving a durable audit value.
    NEW.workspace_id := agent_workspace;

    -- Completed/failed/cancelled history remains mutable enough for FK cleanup.
    IF NEW.status NOT IN ('queued', 'deferred', 'dispatched', 'running', 'waiting_local_directory') THEN
        RETURN NEW;
    END IF;

    IF NEW.runtime_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM agent_runtime runtime
        WHERE runtime.id = NEW.runtime_id AND runtime.workspace_id = agent_workspace
    ) THEN
        RAISE EXCEPTION 'agent task workspace invariant violated: runtime workspace differs from agent workspace';
    END IF;

    SELECT issue.workspace_id INTO source_workspace FROM issue WHERE issue.id = NEW.issue_id;
    IF source_workspace IS NOT NULL AND source_workspace <> agent_workspace THEN
        RAISE EXCEPTION 'agent task workspace invariant violated: issue workspace differs from agent workspace';
    END IF;

    SELECT chat.workspace_id INTO source_workspace FROM chat_session chat WHERE chat.id = NEW.chat_session_id;
    IF source_workspace IS NOT NULL AND source_workspace <> agent_workspace THEN
        RAISE EXCEPTION 'agent task workspace invariant violated: chat workspace differs from agent workspace';
    END IF;

    SELECT autopilot.workspace_id INTO source_workspace
    FROM autopilot_run run JOIN autopilot ON autopilot.id = run.autopilot_id
    WHERE run.id = NEW.autopilot_run_id;
    IF source_workspace IS NOT NULL AND source_workspace <> agent_workspace THEN
        RAISE EXCEPTION 'agent task workspace invariant violated: autopilot workspace differs from agent workspace';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_task_queue_enforce_workspace_trigger ON agent_task_queue;
CREATE TRIGGER agent_task_queue_enforce_workspace_trigger
    BEFORE INSERT OR UPDATE OF agent_id, runtime_id, issue_id, chat_session_id,
        autopilot_run_id, status, workspace_id ON agent_task_queue
    FOR EACH ROW EXECUTE FUNCTION agent_task_queue_enforce_workspace();
