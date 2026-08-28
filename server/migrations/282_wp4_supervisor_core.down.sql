ALTER TABLE agent_task_queue DROP COLUMN IF EXISTS build_run_id;
DROP TABLE IF EXISTS build_run;
DROP TABLE IF EXISTS build_budget;
DROP SEQUENCE IF EXISTS build_fence_seq;
