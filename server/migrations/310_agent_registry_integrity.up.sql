-- Repair the two known registry hazards before enforcing global identity.
DO $$
DECLARE n text; i text;
BEGIN
  SELECT name, instructions INTO n, i FROM agent WHERE id = 'e770fba0-d696-4d14-83d0-b850712af524';
  IF NOT FOUND OR n <> 'gsp-spec-ox-alpha' OR coalesce(length(i), 0) <> 0 THEN
    RAISE EXCEPTION 'agent registry repair refused: ox-alpha row does not match report';
  END IF;
  SELECT name INTO n FROM agent WHERE id = 'be0b788e-f24e-4172-bdc7-85bbf364dd70';
  IF NOT FOUND OR n <> 'gsp-spec-sol-low-public' THEN
    RAISE EXCEPTION 'agent registry repair refused: duplicate row does not match report';
  END IF;
  UPDATE agent SET instructions = 'Read RUNBOOK_SPEC_WORKER.md. Own the Spec stage and produce a conforming specification.'
    WHERE id = 'e770fba0-d696-4d14-83d0-b850712af524';
  UPDATE agent SET name = 'gsp-spec-sol-low-public-legacy'
    WHERE id = 'be0b788e-f24e-4172-bdc7-85bbf364dd70';
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS agent_name_global_unique ON agent (name);
