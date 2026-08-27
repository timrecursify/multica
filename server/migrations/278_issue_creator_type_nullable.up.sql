-- Historical imports can contain issues without creator attribution. Keep the
-- migrated schema aligned with production, where creator_type is nullable.
-- Only creator_type is relaxed; issue numbers and creator_id stay NOT NULL.
ALTER TABLE issue
    ALTER COLUMN creator_type DROP NOT NULL;
