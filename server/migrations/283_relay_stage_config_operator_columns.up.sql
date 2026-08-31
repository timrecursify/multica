-- GSP-806 (PPP) operator relay-config surface: bring relay_stage_config in
-- line with the deployed PPP/GSP board vocabulary and make stage ownership
-- visible/editable through the operator API.
--
-- The base table (migration 279) only carried id/stage_name/next_stage. The
-- live relay reads agent_id (who owns the transition OUT of a stage), the
-- display agent_name, and alt_next_stages (additional legal successors, e.g.
-- In Review -> Human Review on a QC FAIL). This migration backfills those
-- columns idempotently and upserts the canonical stage set that both boards
-- actually use (CI/CD & Deploy, Human Review, Done, Cancelled), so the
-- operator surface can list/get/set/restore ownership for exact transitions.

ALTER TABLE relay_stage_config
    ADD COLUMN IF NOT EXISTS workspace_id uuid,
    ADD COLUMN IF NOT EXISTS source_stage text,
    ADD COLUMN IF NOT EXISTS successor_stage text,
    ADD COLUMN IF NOT EXISTS agent_id uuid,
    ADD COLUMN IF NOT EXISTS agent_name text,
    ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS alt_next_stages text[];

UPDATE relay_stage_config SET source_stage = stage_name WHERE source_stage IS NULL;
UPDATE relay_stage_config SET successor_stage = next_stage WHERE successor_stage IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS relay_stage_config_workspace_transition_uq
    ON relay_stage_config (workspace_id, source_stage, successor_stage);

INSERT INTO relay_stage_config (id, stage_name, next_stage, alt_next_stages)
VALUES
    (1,  'Registered',    'Spec',            NULL),
    (2,  'Spec',          'Queue',           ARRAY['Human Review','Cancelled']),
    (3,  'Queue',         'In Progress',     ARRAY['Human Review']),
    (4,  'In Progress',   'In Review',       ARRAY['Human Review','Queue']),
    (5,  'In Review',     'CI/CD & Deploy',  ARRAY['Human Review','In Progress']),
    (6,  'Human Review',  'CI/CD & Deploy',  ARRAY['Cancelled','In Progress','Queue']),
    (7,  'CI/CD & Deploy','Done',            ARRAY['In Progress','Queue','Spec']),
    (8,  'Done',          'Archived',        ARRAY['CI/CD & Deploy']),
    (9,  'Archived',      NULL,              ARRAY['CI/CD & Deploy']),
    (10, 'Cancelled',     NULL,              NULL)
ON CONFLICT (id) DO UPDATE
    SET stage_name = EXCLUDED.stage_name,
        next_stage = EXCLUDED.next_stage,
        alt_next_stages = EXCLUDED.alt_next_stages;
