-- Record funnel transitions in the same transaction as the issue write. This
-- is separate from activity_log so metrics cannot change timeline semantics.
CREATE TABLE issue_funnel_transition (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sequence BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    workspace_id UUID NOT NULL,
    issue_id UUID NOT NULL,
    stage TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION record_issue_funnel_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO issue_funnel_transition (workspace_id, issue_id, stage)
        VALUES (NEW.workspace_id, NEW.id, 'created');
        IF NEW.assignee_type IS NOT NULL OR NEW.assignee_id IS NOT NULL THEN
            INSERT INTO issue_funnel_transition (workspace_id, issue_id, stage)
            VALUES (NEW.workspace_id, NEW.id, 'assigned');
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.assignee_type IS DISTINCT FROM NEW.assignee_type
       OR OLD.assignee_id IS DISTINCT FROM NEW.assignee_id THEN
        INSERT INTO issue_funnel_transition (workspace_id, issue_id, stage)
        VALUES (NEW.workspace_id, NEW.id, 'assigned');
    END IF;

    IF OLD.status IS DISTINCT FROM NEW.status THEN
        -- Product workflows have several backlog and terminal states. The
        -- delivery funnel deliberately records only its canonical milestones.
        -- Keep the stored stage stable when a workspace uses title-cased
        -- workflow labels (for example, "Done" or "In Review").
        CASE lower(replace(NEW.status, ' ', '_'))
            WHEN 'in_progress' THEN
                INSERT INTO issue_funnel_transition (workspace_id, issue_id, stage)
                VALUES (NEW.workspace_id, NEW.id, 'in_progress');
            WHEN 'in_review' THEN
                INSERT INTO issue_funnel_transition (workspace_id, issue_id, stage)
                VALUES (NEW.workspace_id, NEW.id, 'review');
            WHEN 'review' THEN
                INSERT INTO issue_funnel_transition (workspace_id, issue_id, stage)
                VALUES (NEW.workspace_id, NEW.id, 'review');
            WHEN 'done' THEN
                INSERT INTO issue_funnel_transition (workspace_id, issue_id, stage)
                VALUES (NEW.workspace_id, NEW.id, 'done');
            ELSE
                NULL;
        END CASE;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER issue_funnel_insert_transition_trigger
AFTER INSERT ON issue
FOR EACH ROW
EXECUTE FUNCTION record_issue_funnel_transition();

CREATE TRIGGER issue_funnel_update_transition_trigger
AFTER UPDATE OF status, assignee_type, assignee_id ON issue
FOR EACH ROW
WHEN (
    OLD.status IS DISTINCT FROM NEW.status
    OR OLD.assignee_type IS DISTINCT FROM NEW.assignee_type
    OR OLD.assignee_id IS DISTINCT FROM NEW.assignee_id
)
EXECUTE FUNCTION record_issue_funnel_transition();

-- A stage begins at issue creation, assignment, or a status transition and
-- ends at the next transition. Grafana can filter/group this view directly.
CREATE VIEW issue_funnel_stage_duration AS
WITH ordered_events AS (
    SELECT
        t.workspace_id,
        t.issue_id,
        i.number AS issue_number,
        t.stage,
        t.sequence AS transition_sequence,
        t.occurred_at AS entered_at,
        LEAD(t.occurred_at) OVER (
            PARTITION BY issue_id
            ORDER BY t.occurred_at, t.sequence
        ) AS exited_at
    FROM issue_funnel_transition t
    JOIN issue i ON i.id = t.issue_id AND i.workspace_id = t.workspace_id
)
SELECT
    workspace_id,
    issue_id,
    issue_number,
    stage,
    transition_sequence,
    entered_at,
    COALESCE(exited_at, now()) AS exited_at,
    EXTRACT(EPOCH FROM (COALESCE(exited_at, now()) - entered_at))::bigint AS duration_seconds,
    exited_at IS NULL AS is_open
FROM ordered_events;
