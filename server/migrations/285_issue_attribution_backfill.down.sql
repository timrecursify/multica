ALTER TABLE issue
    ALTER COLUMN number DROP NOT NULL,
    ALTER COLUMN creator_type DROP DEFAULT,
    ALTER COLUMN creator_type DROP NOT NULL;

DROP INDEX IF EXISTS issue_workspace_number_sentinel_idx;
UPDATE issue SET number = NULL WHERE number < 0;
