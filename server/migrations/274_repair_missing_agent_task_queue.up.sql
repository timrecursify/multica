-- Repair a database where schema_migrations records the queue history but the
-- physical agent_task_queue relation is absent. In that state daemon task
-- claims fail with PostgreSQL "relation does not exist" errors.
--
-- This is intentionally a schema-only repair: a missing relation has no task
-- rows to recover. It reproduces the current queue shape and its original
-- referential actions. Claim-path indexes are rebuilt separately, because
-- PostgreSQL requires CREATE INDEX CONCURRENTLY to run as a single statement.
CREATE TABLE IF NOT EXISTS agent_task_queue (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id uuid NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
    issue_id uuid REFERENCES issue(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'dispatched', 'running', 'completed', 'failed', 'cancelled', 'waiting_local_directory', 'deferred')),
    priority integer NOT NULL DEFAULT 0,
    dispatched_at timestamptz,
    started_at timestamptz,
    completed_at timestamptz,
    result jsonb,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    context jsonb,
    runtime_id uuid REFERENCES agent_runtime(id) ON DELETE CASCADE,
    session_id text,
    work_dir text,
    trigger_comment_id uuid REFERENCES comment(id) ON DELETE SET NULL,
    chat_session_id uuid REFERENCES chat_session(id) ON DELETE SET NULL,
    autopilot_run_id uuid REFERENCES autopilot_run(id) ON DELETE SET NULL,
    attempt integer NOT NULL DEFAULT 1,
    max_attempts integer NOT NULL DEFAULT 2,
    parent_task_id uuid REFERENCES agent_task_queue(id) ON DELETE SET NULL,
    failure_reason text,
    trigger_summary text,
    force_fresh_session boolean NOT NULL DEFAULT false,
    is_leader_task boolean NOT NULL DEFAULT false,
    wait_reason text,
    initiator_user_id uuid,
    handoff_note text,
    prepare_lease_expires_at timestamptz,
    squad_id uuid,
    runtime_mcp_overlay jsonb,
    escalation_for_task_id uuid,
    fire_at timestamptz,
    originator_user_id uuid,
    runtime_connected_apps jsonb,
    coalesced_comment_ids uuid[] NOT NULL DEFAULT '{}',
    delivered_comment_ids uuid[] NOT NULL DEFAULT '{}',
    chat_input_task_id uuid,
    chat_finalize_deferred_at timestamptz,
    originator_source text,
    delegated_from_task_id uuid,
    retry_of_task_id uuid,
    rerun_of_task_id uuid,
    rule_version_id uuid,
    trigger_evidence_kind text,
    trigger_evidence_ref_id uuid,
    accountable_user_id uuid,
    session_rollout_missing boolean NOT NULL DEFAULT false,
    retired_session_id text,
    quick_actions_disabled boolean NOT NULL DEFAULT false,
    regenerate_quick_actions_for uuid,
    CONSTRAINT agent_task_queue_accountable_matches_originator CHECK (
        originator_user_id IS NULL
        OR (accountable_user_id IS NOT NULL AND accountable_user_id = originator_user_id)
    ),
    CONSTRAINT agent_task_queue_active_requires_runtime CHECK (
        runtime_id IS NOT NULL OR completed_at IS NOT NULL
    ) NOT VALID
);

-- These triggers were installed by prior migrations. Re-create them only
-- when a missing queue table makes their original creation a no-op in effect.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'agent_task_queue'::regclass
          AND tgname = 'trg_atq_dirty_hourly'
          AND NOT tgisinternal
    ) THEN
        CREATE TRIGGER trg_atq_dirty_hourly
            BEFORE DELETE OR UPDATE OF runtime_id, issue_id ON agent_task_queue
            FOR EACH ROW
            WHEN (current_setting('multica.workspace_teardown', true) IS DISTINCT FROM 'on')
            EXECUTE FUNCTION enqueue_task_usage_hourly_dirty_for_atq();
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'agent_task_queue'::regclass
          AND tgname = 'trg_clear_runtime_mcp_overlay'
          AND NOT tgisinternal
    ) THEN
        CREATE TRIGGER trg_clear_runtime_mcp_overlay
            BEFORE UPDATE OF status ON agent_task_queue
            FOR EACH ROW
            EXECUTE FUNCTION clear_runtime_mcp_overlay_on_terminal_state();
    END IF;
END;
$$;
