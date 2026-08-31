-- GSP-868 rollback: revoke the Cancelled successor added by up from the active
-- workflow stages. next_stage is never touched. The terminal Cancelled row is
-- intentionally left in place: a deployment may have provisioned it out-of-band
-- under any id, so dropping it here risks deleting a row the relay already
-- depends on. Removing the successor edges is the full reversal of this
-- migration's contract change.

UPDATE relay_stage_config
SET alt_next_stages = array_remove(
        COALESCE(alt_next_stages, '{}'),
        'Cancelled'
    )
WHERE stage_name IN ('Queue', 'In Progress', 'In Review', 'CI/CD & Deploy');
