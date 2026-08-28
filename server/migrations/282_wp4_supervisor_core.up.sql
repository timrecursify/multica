-- WP-4 reasonix integration surface for the WP-10a supervisor core.
--
-- Relationships are application-enforced per the repository migration contract:
-- no foreign keys or cascading actions are introduced.  Indexes are created in
-- the following single-statement migrations so they can use CONCURRENTLY.
CREATE SEQUENCE build_fence_seq AS bigint START 1 INCREMENT 1 NO CYCLE;

CREATE TABLE build_budget (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL,
    scope text NOT NULL,
    scope_ref text NOT NULL,
    limit_ticks bigint NOT NULL,
    reserved_ticks bigint NOT NULL DEFAULT 0,
    spent_ticks bigint NOT NULL DEFAULT 0,
    state text NOT NULL DEFAULT 'open',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT build_budget_state_ck CHECK (state IN ('open', 'frozen', 'closed')),
    CONSTRAINT build_budget_scope_ck CHECK (scope IN ('issue', 'lane_daily')),
    CONSTRAINT build_budget_nonnegative_ck CHECK (
        limit_ticks >= 0 AND reserved_ticks >= 0 AND spent_ticks >= 0
    ),
    CONSTRAINT build_budget_ceiling_ck CHECK (reserved_ticks + spent_ticks <= limit_ticks)
);

CREATE TABLE build_run (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL,
    issue_id uuid NOT NULL,
    task_id uuid,
    agent_id uuid NOT NULL,
    lane text NOT NULL,
    run_number integer NOT NULL,
    fence bigint NOT NULL DEFAULT nextval('build_fence_seq'),
    lease_holder text NOT NULL,
    lease_expires_at timestamptz NOT NULL,
    heartbeat_at timestamptz NOT NULL DEFAULT now(),
    state text NOT NULL DEFAULT 'running',
    budget_id uuid NOT NULL,
    deadline_at timestamptz NOT NULL,
    claimed_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz,
    terminal_reason text,
    detail jsonb NOT NULL DEFAULT '{}',
    CONSTRAINT build_run_number_ck CHECK (run_number >= 1),
    CONSTRAINT build_run_state_ck CHECK (state IN ('running', 'completed', 'failed', 'parked', 'swept')),
    CONSTRAINT build_run_terminal_reason_ck CHECK (
        terminal_reason IS NULL OR terminal_reason IN (
            'ok', 'defect', 'blocked_provider', 'blocked_spec',
            'budget_exhausted', 'deadline_exceeded', 'lease_lost', 'cancelled'
        )
    ),
    CONSTRAINT build_run_terminal_ck CHECK (
        (state = 'running' AND ended_at IS NULL AND terminal_reason IS NULL)
        OR (state <> 'running' AND ended_at IS NOT NULL AND terminal_reason IS NOT NULL)
    )
);

ALTER TABLE agent_task_queue ADD COLUMN build_run_id uuid;
