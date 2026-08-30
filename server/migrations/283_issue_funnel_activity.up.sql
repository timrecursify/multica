-- Record funnel transitions in the same transaction as the issue write. The
-- application event listener is asynchronous and does not observe relay or
-- direct database updates.
CREATE OR REPLACE FUNCTION record_issue_funnel_activity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.assignee_type IS NOT NULL OR NEW.assignee_id IS NOT NULL THEN
            INSERT INTO activity_log (workspace_id, issue_id, actor_type, action, details)
            VALUES (
                NEW.workspace_id,
                NEW.id,
                'system',
                'assignee_changed',
                jsonb_strip_nulls(jsonb_build_object(
                    'to_type', NEW.assignee_type,
                    'to_id', NEW.assignee_id,
                    'source', 'database_trigger'
                ))
            );
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.status IS DISTINCT FROM NEW.status THEN
        INSERT INTO activity_log (workspace_id, issue_id, actor_type, action, details)
        VALUES (
            NEW.workspace_id,
            NEW.id,
            'system',
            'status_changed',
            jsonb_build_object('from', OLD.status, 'to', NEW.status, 'source', 'database_trigger')
        );
    END IF;

    IF OLD.assignee_type IS DISTINCT FROM NEW.assignee_type
       OR OLD.assignee_id IS DISTINCT FROM NEW.assignee_id THEN
        INSERT INTO activity_log (workspace_id, issue_id, actor_type, action, details)
        VALUES (
            NEW.workspace_id,
            NEW.id,
            'system',
            'assignee_changed',
            jsonb_strip_nulls(jsonb_build_object(
                'from_type', OLD.assignee_type,
                'from_id', OLD.assignee_id,
                'to_type', NEW.assignee_type,
                'to_id', NEW.assignee_id,
                'source', 'database_trigger'
            ))
        );
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER issue_funnel_insert_activity_trigger
AFTER INSERT ON issue
FOR EACH ROW
EXECUTE FUNCTION record_issue_funnel_activity();

CREATE TRIGGER issue_funnel_update_activity_trigger
AFTER UPDATE OF status, assignee_type, assignee_id ON issue
FOR EACH ROW
WHEN (
    OLD.status IS DISTINCT FROM NEW.status
    OR OLD.assignee_type IS DISTINCT FROM NEW.assignee_type
    OR OLD.assignee_id IS DISTINCT FROM NEW.assignee_id
)
EXECUTE FUNCTION record_issue_funnel_activity();

-- A stage begins at issue creation, assignment, or a status transition and
-- ends at the next funnel event. Grafana can filter/group this view directly.
CREATE VIEW issue_funnel_stage_duration AS
WITH funnel_events AS (
    SELECT
        i.workspace_id,
        i.id AS issue_id,
        i.number AS issue_number,
        'created'::text AS stage,
        i.created_at AS entered_at
    FROM issue i
    UNION ALL
    SELECT
        a.workspace_id,
        a.issue_id,
        i.number AS issue_number,
        CASE
            WHEN a.action = 'assignee_changed' THEN 'assigned'
            ELSE a.details->>'to'
        END AS stage,
        a.created_at AS entered_at
    FROM activity_log a
    JOIN issue i ON i.id = a.issue_id AND i.workspace_id = a.workspace_id
    WHERE a.action IN ('status_changed', 'assignee_changed')
), ordered_events AS (
    SELECT
        workspace_id,
        issue_id,
        issue_number,
        stage,
        entered_at,
        LEAD(entered_at) OVER (
            PARTITION BY issue_id
            ORDER BY entered_at, stage
        ) AS exited_at
    FROM funnel_events
)
SELECT
    workspace_id,
    issue_id,
    issue_number,
    stage,
    entered_at,
    COALESCE(exited_at, now()) AS exited_at,
    EXTRACT(EPOCH FROM (COALESCE(exited_at, now()) - entered_at))::bigint AS duration_seconds,
    exited_at IS NULL AS is_open
FROM ordered_events;
