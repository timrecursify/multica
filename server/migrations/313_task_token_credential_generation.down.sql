DROP INDEX IF EXISTS idx_task_token_credential_generation;
ALTER TABLE task_token DROP COLUMN IF EXISTS credential_generation;
