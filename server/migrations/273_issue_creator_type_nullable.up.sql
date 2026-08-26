-- Historical imports can contain issues without creator attribution. Keep the
-- migrated schema aligned with production, where creator_type is nullable.
ALTER TABLE issue
    ALTER COLUMN creator_type DROP NOT NULL,
    ALTER COLUMN number DROP NOT NULL;
