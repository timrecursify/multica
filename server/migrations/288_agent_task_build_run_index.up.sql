CREATE INDEX CONCURRENTLY idx_agent_task_queue_build_run ON agent_task_queue (build_run_id) WHERE build_run_id IS NOT NULL;
