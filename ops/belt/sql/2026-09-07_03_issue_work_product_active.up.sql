CREATE UNIQUE INDEX CONCURRENTLY issue_work_product_active_idx ON issue_work_product (issue_id) WHERE status = 'active';
