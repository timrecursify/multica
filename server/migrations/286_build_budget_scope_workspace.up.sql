-- GSP-148: restore the workspace-scoped build-budget natural key after the
-- historical runtime migration-number collision. The migrator hook rejects a
-- valid index with a different definition and removes only an INVALID retry
-- leftover before this concurrent build runs.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_build_budget_scope_workspace
    ON build_budget (workspace_id, scope, scope_ref);
