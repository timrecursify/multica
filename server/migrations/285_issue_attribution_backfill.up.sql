-- Historical imports bypassed the application default and left issue rows
-- without creator attribution. Preserve list availability while making future
-- omitted values deterministic.
UPDATE issue
SET creator_type = 'agent'
WHERE creator_type IS NULL;

ALTER TABLE issue
    ALTER COLUMN creator_type SET DEFAULT 'agent',
    ALTER COLUMN creator_type SET NOT NULL;

UPDATE issue
SET number = correction.row_number
WHERE number IS NULL
  AND id = correction.id
FROM (
    SELECT id, -ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY created_at, id) AS row_number
    FROM issue
    WHERE number IS NULL
) AS correction;

ALTER TABLE issue
    ALTER COLUMN number SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS issue_workspace_number_sentinel_idx
    ON issue (workspace_id, number)
    WHERE number < 0;
