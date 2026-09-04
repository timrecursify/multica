CREATE INDEX CONCURRENTLY idx_issue_funnel_transition_workspace_occurred
    ON issue_funnel_transition (workspace_id, occurred_at DESC);
