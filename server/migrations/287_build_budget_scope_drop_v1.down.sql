-- Recreating the tenant-blind key can reject valid cross-workspace rows.
-- A rollback therefore requires an explicit, reviewed remediation plan.
DO $$
BEGIN
    RAISE EXCEPTION '287_build_budget_scope_drop_v1 is irreversible without explicit build_budget remediation';
END;
$$;
