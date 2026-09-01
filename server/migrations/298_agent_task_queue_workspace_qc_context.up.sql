ALTER TABLE agent_task_queue ADD COLUMN IF NOT EXISTS workspace_id uuid;

UPDATE agent_task_queue task
SET workspace_id = issue.workspace_id,
    context = jsonb_strip_nulls(COALESCE(task.context, '{}'::jsonb) ||
      jsonb_build_object('to_stage', issue.status))
FROM issue
WHERE issue.id = task.issue_id
  AND task.rerun_of_task_id IS NOT NULL
  AND (task.workspace_id IS NULL OR task.context->>'to_stage' IS NULL);
