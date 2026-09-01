-- Rollback ordering only: its down migration removes PPP rows before the
-- workspace composite index is dropped and the legacy global index is rebuilt.
SELECT 1;
