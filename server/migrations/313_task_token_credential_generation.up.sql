ALTER TABLE task_token ADD COLUMN credential_generation UUID;
CREATE INDEX idx_task_token_credential_generation ON task_token(credential_generation);
