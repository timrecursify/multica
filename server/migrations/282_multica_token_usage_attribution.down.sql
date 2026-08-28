ALTER TABLE task_usage
    DROP CONSTRAINT task_usage_task_id_provider_model_attempt_key;
ALTER TABLE task_usage
    ADD CONSTRAINT task_usage_task_id_provider_model_key
    UNIQUE (task_id, provider, model);

ALTER TABLE task_usage
    DROP CONSTRAINT ck_task_usage_usage_source;

ALTER TABLE task_usage
    DROP COLUMN attempt_no,
    DROP COLUMN runtime_id,
    DROP COLUMN usage_source;
