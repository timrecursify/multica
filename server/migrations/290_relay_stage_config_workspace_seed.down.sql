DELETE FROM relay_stage_config WHERE workspace_id = 'da3c5c5c-a123-4567-b999-c3ed1820da00'::uuid;

ALTER TABLE relay_stage_config ADD CONSTRAINT relay_stage_config_stage_name_key UNIQUE (stage_name);
