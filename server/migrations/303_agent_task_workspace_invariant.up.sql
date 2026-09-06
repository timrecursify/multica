-- Persist the workspace an agent task is authorized to act in.  Agent is the
-- authority for tasks without a source (notably quick-create); issue, chat,
-- autopilot and runtime must agree before an active task can be admitted.
ALTER TABLE agent_task_queue
    ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspace(id) ON DELETE CASCADE;

UPDATE agent_task_queue task
SET workspace_id = agent.workspace_id
FROM agent
WHERE agent.id = task.agent_id
  AND task.workspace_id IS NULL;

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

    -- A caller may carry a workspace assertion from a relay or creation path;
    -- never silently rewrite a conflicting assertion into an apparently-valid
    -- active task.
    IF NEW.workspace_id IS NOT NULL AND NEW.workspace_id <> agent_workspace THEN
        RAISE EXCEPTION 'agent task workspace invariant violated: task workspace differs from agent workspace';
    END IF;

    -- Always persist the agent-owned workspace, including historical rows.
    NEW.workspace_id := agent_workspace;

    -- Terminal history must survive source/runtime deletion and archival.
    IF NEW.status NOT IN ('queued', 'deferred', 'dispatched', 'running', 'waiting_local_directory') THEN
        RETURN NEW;
    END IF;

    IF NEW.runtime_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM agent_runtime runtime
        WHERE runtime.id = NEW.runtime_id AND runtime.workspace_id = agent_workspace
    ) THEN
        RAISE EXCEPTION 'agent task workspace invariant violated: runtime workspace differs from agent workspace';
    END IF;

    SELECT workspace_id INTO source_workspace FROM issue WHERE id = NEW.issue_id;
    IF source_workspace IS NOT NULL AND source_workspace <> agent_workspace THEN
        RAISE EXCEPTION 'agent task workspace invariant violated: issue workspace differs from agent workspace';
    END IF;

    SELECT workspace_id INTO source_workspace FROM chat_session WHERE id = NEW.chat_session_id;
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
