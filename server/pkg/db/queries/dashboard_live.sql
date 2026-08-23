-- name: ListDashboardRunTimeDaily :many
-- Daily ticket-transition counts from activity_log for the dashboard task
-- volume metric. Duration is explicitly zero because transitions do not carry
-- per-run duration.
SELECT
    DATE(activity.created_at AT TIME ZONE sqlc.arg('tz')::text) AS date,
    0::bigint AS total_seconds,
    COUNT(*)::int AS task_count,
    0::int AS failed_count,
    0::int AS cancelled_count
FROM activity_log activity
JOIN issue i ON i.id = activity.issue_id AND i.workspace_id = activity.workspace_id
WHERE activity.workspace_id = $1
  AND activity.action = 'status_changed'
  AND activity.created_at >= sqlc.arg('since')::timestamptz
  AND (sqlc.narg('project_id')::uuid IS NULL OR i.project_id = sqlc.narg('project_id'))
GROUP BY DATE(activity.created_at AT TIME ZONE sqlc.arg('tz')::text)
ORDER BY DATE(activity.created_at AT TIME ZONE sqlc.arg('tz')::text) DESC;

-- name: ListDashboardAgentRunTime :many
-- Per-agent ticket-transition counts from activity_log for the dashboard.
SELECT
    activity.actor_id::uuid AS agent_id,
    0::bigint AS total_seconds,
    COUNT(*)::int AS task_count,
    0::int AS failed_count,
    0::int AS cancelled_count
FROM activity_log activity
JOIN issue i ON i.id = activity.issue_id AND i.workspace_id = activity.workspace_id
WHERE activity.workspace_id = $1
  AND activity.actor_type = 'agent'
  AND activity.action = 'status_changed'
  AND activity.created_at >= @since::timestamptz
  AND (sqlc.narg('project_id')::uuid IS NULL OR i.project_id = sqlc.narg('project_id'))
GROUP BY activity.actor_id
ORDER BY COUNT(*) DESC;

-- name: ListDashboardFailuresDaily :many
-- Daily transition counts by machine-readable failure reason. Empty means a
-- successful or otherwise unclassified status transition and remains visible
-- as the denominator row.
SELECT
    DATE(activity.created_at AT TIME ZONE sqlc.arg('tz')::text) AS date,
    COALESCE(NULLIF(activity.details->>'failure_reason', ''), ''::text)::text AS failure_reason,
    COUNT(*)::int AS task_count
FROM activity_log activity
JOIN issue i ON i.id = activity.issue_id AND i.workspace_id = activity.workspace_id
WHERE activity.workspace_id = $1
  AND activity.action = 'status_changed'
  AND activity.created_at >= sqlc.arg('since')::timestamptz
  AND (sqlc.narg('project_id')::uuid IS NULL OR i.project_id = sqlc.narg('project_id'))
GROUP BY 1, 2
ORDER BY 1 DESC, 2;

-- name: ListDashboardFailuresByAgent :many
-- Per-agent transition counts by machine-readable failure reason. Empty means
-- a successful or otherwise unclassified status transition.
SELECT
    activity.actor_id::uuid AS agent_id,
    COALESCE(NULLIF(activity.details->>'failure_reason', ''), ''::text)::text AS failure_reason,
    COUNT(*)::int AS task_count
FROM activity_log activity
JOIN issue i ON i.id = activity.issue_id AND i.workspace_id = activity.workspace_id
WHERE activity.workspace_id = $1
  AND activity.actor_type = 'agent'
  AND activity.action = 'status_changed'
  AND activity.created_at >= @since::timestamptz
  AND (sqlc.narg('project_id')::uuid IS NULL OR i.project_id = sqlc.narg('project_id'))
GROUP BY activity.actor_id, 2
ORDER BY activity.actor_id, 2;
