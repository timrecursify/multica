-- The 2026-08-25 reconstruction inserted issues without creator attribution.
-- sqlc scans both columns into non-nullable Go values, so repair historical
-- rows before restoring the schema contract declared by the initial migration.
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
    DROP CONSTRAINT IF EXISTS issue_creator_type_check,
    ADD CONSTRAINT issue_creator_type_check
        CHECK (creator_type IN ('member', 'agent'));
