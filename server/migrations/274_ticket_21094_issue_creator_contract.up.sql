-- Ticket #21094: reconstruction rows with NULL creator fields cannot be
-- scanned by the generated Issue model. Repair existing data before restoring
-- the invariant declared by the initial schema.
UPDATE issue
SET creator_type = 'agent'
WHERE creator_type IS NULL;

UPDATE issue
SET creator_id = '00000000-0000-0000-0000-000000000000'
WHERE creator_id IS NULL;

ALTER TABLE issue
    ALTER COLUMN creator_type SET NOT NULL,
    ALTER COLUMN creator_id SET NOT NULL;

ALTER TABLE issue
    DROP CONSTRAINT IF EXISTS issue_creator_type_check;

ALTER TABLE issue
    ADD CONSTRAINT issue_creator_type_check
    CHECK (creator_type IN ('member', 'agent'));
