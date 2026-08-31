-- GSP-868 / GSP-458 / GSP-655: sanction Cancelled as a terminal relay
-- transition from the active workflow stages that still lack it.
--
-- relay_stage_config is the single sanctioned transition graph the relay
-- reads: for an issue in stage S, the legal successors are S.next_stage plus
-- S.alt_next_stages. A terminal 'Cancelled' row already exists in the live
-- graph, but several active stages (notably Queue, In Progress, In Review and
-- CI/CD & Deploy) omit 'Cancelled' from alt_next_stages, so an authorized
--   sk multica advance <ticket> --to Cancelled --board gsp
-- is rejected as invalid_transition and a withdrawn ticket has no sanctioned
-- terminal path. This migration adds 'Cancelled' as a legal terminal successor
-- of those stages without touching next_stage, so ordinary non-cancellation
-- transitions stay exactly as strict as before.
--
-- Additive and idempotent: migration 283 (operator relay-config surface) adds
-- the alt_next_stages column; if it has not yet applied, add the column here
-- so the UPDATE below is valid. Rows are touched only where 'Cancelled' is not
-- already present, so a re-apply is a no-op.

ALTER TABLE relay_stage_config
    ADD COLUMN IF NOT EXISTS alt_next_stages text[];

UPDATE relay_stage_config
SET alt_next_stages = array_append(
        COALESCE(alt_next_stages, '{}'),
        'Cancelled'
    )
WHERE stage_name IN ('Queue', 'In Progress', 'In Review', 'CI/CD & Deploy')
  AND 'Cancelled' <> ALL (COALESCE(alt_next_stages, '{}'));

-- The terminal Cancelled stage must exist and stay terminal (next_stage NULL),
-- even when a deployment provisioned the row out-of-band. Insert by stage_name
-- so a pre-existing row under any id is left untouched.
INSERT INTO relay_stage_config (id, stage_name, next_stage)
SELECT 10, 'Cancelled', NULL
WHERE NOT EXISTS (
    SELECT 1 FROM relay_stage_config WHERE stage_name = 'Cancelled'
);
