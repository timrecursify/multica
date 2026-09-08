-- A queued task must never bridge tenants.  The workspace is derived from its
-- issue, chat session, autopilot run, or quick-create context and must agree
-- with both its agent and its runtime.
CREATE OR REPLACE FUNCTION enforce_agent_task_workspace_invariant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    task_workspace UUID;
    agent_workspace UUID;
    runtime_workspace UUID;
BEGIN
    SELECT workspace_id INTO agent_workspace FROM agent WHERE id = NEW.agent_id;
    SELECT workspace_id INTO runtime_workspace FROM agent_runtime WHERE id = NEW.runtime_id;

    SELECT COALESCE(
        (SELECT workspace_id FROM issue WHERE id = NEW.issue_id),
        (SELECT workspace_id FROM chat_session WHERE id = NEW.chat_session_id),
        (SELECT ap.workspace_id FROM autopilot_run ar JOIN autopilot ap ON ap.id = ar.autopilot_id WHERE ar.id = NEW.autopilot_run_id),
        NULLIF(NEW.context->>'workspace_id', '')::uuid
    ) INTO task_workspace;

    IF agent_workspace IS NULL OR runtime_workspace IS NULL OR task_workspace IS NULL
       OR agent_workspace <> runtime_workspace OR agent_workspace <> task_workspace THEN
        RAISE EXCEPTION 'agent task workspace invariant violated'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER agent_task_workspace_invariant
BEFORE INSERT OR UPDATE OF agent_id, runtime_id, issue_id, chat_session_id, autopilot_run_id, context
ON agent_task_queue
FOR EACH ROW EXECUTE FUNCTION enforce_agent_task_workspace_invariant();
