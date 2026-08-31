-- GSP-591: scope relay stage configuration by workspace and add the relay run
-- ledger the bridge needs. Existing rows (workspace_id NULL, the migration 279
-- default) are preserved as the global default config; per-workspace override rows
-- may coexist so each workspace served by one database can configure its own stages,
-- owners, and successor edges. The UNIQUE (stage_name) global constraint must
-- drop so override rows can carry the same stage_name for a different workspace.
-- Stage names still must be unique per workspace (partial index below).
--
-- The GSP/prod bridge schema (relay_stage_config: id, stage_name, next_stage,
-- agent_id, agent_name, created_at; relay_run_log: issue_id, from_stage,
-- to_stage, agent_id, task_id, status, created_at) was the operative contract
-- that kept the belt moving; this migration upstreams exactly that shape and adds
-- workspace scoping + alt_next_stages so a stage may have more than one legal
-- successor (Fable QC decides PASS -> CI/CD & Deploy / Human Review / Done).
ALTER TABLE relay_stage_config
    DROP CONSTRAINT IF EXISTS relay_stage_config_stage_name_key;

ALTER TABLE relay_stage_config
    ADD COLUMN IF NOT EXISTS workspace_id uuid,
    ADD COLUMN IF NOT EXISTS agent_id uuid,
    ADD COLUMN IF NOT EXISTS agent_name text,
    ADD COLUMN IF NOT EXISTS alt_next_stages text[],
    ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE relay_stage_config
    ADD CONSTRAINT relay_stage_config_workspace_id_fkey
        FOREIGN KEY (workspace_id) REFERENCES workspace(id)
        ON DELETE CASCADE;

ALTER TABLE relay_stage_config
    ADD CONSTRAINT relay_stage_config_agent_id_fkey
        FOREIGN KEY (agent_id) REFERENCES agent(id)
        ON DELETE SET NULL;

-- One configuration row per (workspace, stage). NULL workspace is the
-- global default row set (seeded by migration 279).
CREATE UNIQUE INDEX IF NOT EXISTS relay_stage_config_workspace_stage_key
    ON relay_stage_config (workspace_id, stage_name)
    WHERE workspace_id IS NOT NULL;

-- Relay run ledger: records each stage transition attempt and its successor task. 
-- Idempotency is constraint-backed ON CONFLICT DO NOTHING on the successor task below;
-- the ledger row is written once per task creation, so repeated delivery cannot
-- double-count a successor.
CREATE TABLE IF NOT EXISTS relay_run_log (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    issue_id uuid NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    from_stage text NOT NULL,
    to_stage text,
    agent_id uuid,
    task_id uuid UNIQUE,
    status text NOT NULL DEFAULT 'pending',
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT relay_run_log_status_check CHECK (status IN ('pending','completed','failed'))
);
