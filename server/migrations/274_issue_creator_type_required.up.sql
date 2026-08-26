-- Production requires issue creator attribution and issue numbers. Migration
-- 273_issue_creator_type_nullable makes both columns nullable in the
-- migration-derived schema; restore the production contract for new installs.
ALTER TABLE issue
    ALTER COLUMN creator_type SET NOT NULL,
    ALTER COLUMN number SET NOT NULL;
