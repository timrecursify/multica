-- Repair the two known registry hazards when those reported rows exist. The
-- migration also runs on clean databases, where the rows are not present yet.
DO $$
DECLARE
  row_name text;
  id_exists boolean;
  name_exists boolean;
BEGIN
  SELECT name INTO row_name
  FROM agent
  WHERE id = 'e770fba0-d696-4d14-83d0-b850712af524';
  id_exists := FOUND;
  SELECT EXISTS (
    SELECT 1 FROM agent WHERE name = 'gsp-spec-ox-alpha'
  ) INTO name_exists;
  IF (id_exists AND row_name <> 'gsp-spec-ox-alpha')
     OR (name_exists AND NOT id_exists) THEN
    RAISE EXCEPTION 'agent registry repair target mismatch for gsp-spec-ox-alpha';
  END IF;
END
$$;

UPDATE agent
SET instructions = 'Read RUNBOOK_SPEC_WORKER.md. Own the Spec stage and produce a conforming specification.'
WHERE id = 'e770fba0-d696-4d14-83d0-b850712af524'
  AND name = 'gsp-spec-ox-alpha'
  AND coalesce(length(instructions), 0) = 0;

DO $$
DECLARE
  row_name text;
  id_exists boolean;
  name_exists boolean;
BEGIN
  SELECT name INTO row_name
  FROM agent
  WHERE id = 'be0b788e-f24e-4172-bdc7-85bbf364dd70';
  id_exists := FOUND;
  SELECT EXISTS (
    SELECT 1 FROM agent WHERE name = 'gsp-spec-sol-low-public'
  ) INTO name_exists;
  IF (id_exists AND row_name <> 'gsp-spec-sol-low-public')
     OR (name_exists AND NOT id_exists) THEN
    RAISE EXCEPTION 'agent registry repair target mismatch for gsp-spec-sol-low-public';
  END IF;
END
$$;

UPDATE agent
SET name = 'gsp-spec-sol-low-public-legacy'
WHERE id = 'be0b788e-f24e-4172-bdc7-85bbf364dd70'
  AND name = 'gsp-spec-sol-low-public';

CREATE UNIQUE INDEX IF NOT EXISTS agent_name_global_unique ON agent (name);
