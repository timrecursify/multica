-- GSP-806 rollback: the base relay contract (migration 279) exposed only
-- id/stage_name/next_stage. Drop the operator-facing ownership/alt columns
-- and restore the seven canonical rows 279 seeded; ownership data is lost.
ALTER TABLE relay_stage_config
    DROP COLUMN IF EXISTS alt_next_stages,
    DROP COLUMN IF EXISTS created_at,
    DROP COLUMN IF EXISTS agent_name,
    DROP COLUMN IF EXISTS agent_id;

DELETE FROM relay_stage_config WHERE id NOT IN (1, 2, 3, 4, 5, 8, 9);
