CREATE UNIQUE INDEX CONCURRENTLY uq_build_run_issue_number ON build_run (issue_id, run_number);
