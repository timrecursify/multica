-- Drop v1 only after 286 has established the workspace-scoped replacement.
DROP INDEX CONCURRENTLY IF EXISTS uq_build_budget_scope;
