ALTER TABLE issue
    DROP CONSTRAINT IF EXISTS issue_creator_type_check;

ALTER TABLE issue
    ALTER COLUMN creator_type DROP NOT NULL,
    ALTER COLUMN creator_id DROP NOT NULL;
