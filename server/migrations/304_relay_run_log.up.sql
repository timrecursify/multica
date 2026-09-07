-- GSP-591: native relay stage advancement audit ledger.
-- The relay handler writes one row for each successor task it creates.  Keep
-- this migration separate from the older bridge migrations so upgraded
-- installations that already have workspace-scoped stage configuration gain
-- the table without replaying those migrations.
CREATE TABLE IF NOT EXISTS relay_run_log (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    issue_id uuid NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    from_stage text NOT NULL,
    to_stage text,
    agent_id uuid,
    task_id uuid UNIQUE,
    status text NOT NULL DEFAULT 'pending',
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT relay_run_log_status_check CHECK (status IN ('pending', 'completed', 'failed'))
);
