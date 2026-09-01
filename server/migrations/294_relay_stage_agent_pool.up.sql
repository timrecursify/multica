CREATE TABLE relay_stage_agent_pool (
    workspace_id uuid NOT NULL,
    stage_name text NOT NULL,
    agent_id uuid NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);
