-- Repair the two known registry hazards when those reported rows exist. The
-- migration also runs on clean databases, where the rows are not present yet.
UPDATE agent
SET instructions = 'Read RUNBOOK_SPEC_WORKER.md. Own the Spec stage and produce a conforming specification.'
WHERE id = 'e770fba0-d696-4d14-83d0-b850712af524'
  AND name = 'gsp-spec-ox-alpha'
  AND coalesce(length(instructions), 0) = 0;

UPDATE agent
SET name = 'gsp-spec-sol-low-public-legacy'
WHERE id = 'be0b788e-f24e-4172-bdc7-85bbf364dd70'
  AND name = 'gsp-spec-sol-low-public';

CREATE UNIQUE INDEX IF NOT EXISTS agent_name_global_unique ON agent (name);
