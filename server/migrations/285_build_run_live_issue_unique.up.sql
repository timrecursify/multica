CREATE UNIQUE INDEX CONCURRENTLY uq_build_run_live_issue ON build_run (issue_id) WHERE state = 'running';
