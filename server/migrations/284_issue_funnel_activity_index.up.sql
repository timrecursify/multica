CREATE INDEX CONCURRENTLY idx_activity_log_funnel_workspace_created
    ON activity_log (workspace_id, created_at DESC)
    WHERE action IN ('status_changed', 'assignee_changed');
