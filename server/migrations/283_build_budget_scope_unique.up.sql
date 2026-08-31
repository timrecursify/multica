-- Tenant-scope the natural (scope, scope_ref) key so two workspaces cannot
-- collide on the same natural scope reference, and a budget lookup can never
-- resolve cross-tenant. workspace_id is the tenant partition.
CREATE UNIQUE INDEX CONCURRENTLY uq_build_budget_scope ON build_budget (workspace_id, scope, scope_ref);
