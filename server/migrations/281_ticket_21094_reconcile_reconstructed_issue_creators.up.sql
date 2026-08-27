-- The 2026-08-25 reconstruction inserted issues without creator attribution.
-- sqlc scans both creator fields into non-nullable values, so recover those
-- rows before restoring the schema contract.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM issue AS i
        WHERE (i.creator_type IS NULL OR i.creator_id IS NULL)
          AND i.title NOT LIKE 'RECONSTRUCTED%'
    ) THEN
        RAISE EXCEPTION 'issue creator attribution is missing outside reconstruction rows';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM issue AS i
        WHERE (i.creator_type IS NULL OR i.creator_id IS NULL)
          AND i.title LIKE 'RECONSTRUCTED%'
          AND NOT EXISTS (
              SELECT 1
              FROM member AS m
              WHERE m.workspace_id = i.workspace_id
          )
    ) THEN
        RAISE EXCEPTION 'reconstructed issue has no workspace member for creator attribution';
    END IF;
END $$;

UPDATE issue AS i
SET creator_type = 'member',
    creator_id = (
        SELECT m.id
        FROM member AS m
        WHERE m.workspace_id = i.workspace_id
        ORDER BY m.created_at, m.id
        LIMIT 1
    )
WHERE (i.creator_type IS NULL OR i.creator_id IS NULL)
  AND i.title LIKE 'RECONSTRUCTED%';

ALTER TABLE issue
    ALTER COLUMN creator_type SET NOT NULL,
    ALTER COLUMN creator_id SET NOT NULL;

ALTER TABLE issue
    DROP CONSTRAINT IF EXISTS issue_creator_type_check,
    ADD CONSTRAINT issue_creator_type_check
        CHECK (creator_type IN ('member', 'agent'));
