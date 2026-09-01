-- A stage pool is a workspace-owned dispatch policy.  Membership remains in
-- relay_stage_agent_pool so existing installations keep their members while
-- moving from the legacy relay_stage_config.agent_id binding.
CREATE TABLE relay_stage_pool (
    workspace_id uuid NOT NULL,
    stage_name text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    legacy_agent_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
