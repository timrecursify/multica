-- Stage capacity and queue pressure by board.
--
-- ready_count mirrors the relay advance query: a completed task whose pending
-- relay log still points at the issue's current stage. waiting_count is work
-- already admitted to an agent but not running. running_count is execution.
-- Configured capacity is shared when the same agent belongs to several stages.
CREATE OR REPLACE VIEW public.relay_stage_capacity_status AS
WITH running_by_agent AS (
  SELECT task.agent_id, count(*)::integer AS running_count
  FROM public.agent_task_queue task
  WHERE task.status = 'running'
  GROUP BY task.agent_id
),
pool_capacity AS (
  SELECT
    policy.workspace_id,
    policy.stage_name,
    policy.enabled,
    count(membership.agent_id) FILTER (WHERE membership.enabled)::integer AS member_count,
    COALESCE(sum(agent.max_concurrent_tasks) FILTER (WHERE membership.enabled), 0)::integer
      AS capacity_budget,
    COALESCE(sum(
      GREATEST(agent.max_concurrent_tasks - COALESCE(running.running_count, 0), 0)
    ) FILTER (WHERE membership.enabled), 0)::integer AS available_capacity
  FROM public.relay_stage_pool policy
  LEFT JOIN public.relay_stage_agent_pool membership
    ON membership.workspace_id = policy.workspace_id
    AND membership.stage_name = policy.stage_name
  LEFT JOIN public.agent agent ON agent.id = membership.agent_id
  LEFT JOIN running_by_agent running ON running.agent_id = membership.agent_id
  GROUP BY policy.workspace_id, policy.stage_name, policy.enabled
),
relay_ready AS (
  SELECT
    issue.workspace_id,
    relay.to_stage AS stage_name,
    count(*)::integer AS ready_count
  FROM public.agent_task_queue task
  JOIN public.relay_run_log relay
    ON relay.task_id = task.id AND relay.status = 'pending'
  JOIN public.issue issue ON issue.id = task.issue_id
  JOIN public.relay_stage_config stage
    ON stage.workspace_id = issue.workspace_id
    AND stage.stage_name = relay.to_stage
  WHERE task.status = 'completed'
    AND issue.status = relay.to_stage
    AND stage.next_stage IS NOT NULL
  GROUP BY issue.workspace_id, relay.to_stage
),
task_pressure AS (
  SELECT
    task.workspace_id,
    task.context->>'to_stage' AS stage_name,
    count(*) FILTER (
      WHERE task.status IN ('queued', 'dispatched', 'waiting_local_directory', 'deferred')
    )::integer AS waiting_count,
    count(*) FILTER (WHERE task.status = 'running')::integer AS running_count
  FROM public.agent_task_queue task
  WHERE task.issue_id IS NOT NULL
    AND task.context->>'to_stage' IS NOT NULL
    AND task.status IN (
      'queued', 'dispatched', 'running', 'waiting_local_directory', 'deferred'
    )
  GROUP BY task.workspace_id, task.context->>'to_stage'
)
SELECT
  workspace.slug AS workspace_slug,
  pool.workspace_id,
  pool.stage_name,
  pool.enabled,
  pool.member_count,
  pool.capacity_budget,
  pool.available_capacity,
  COALESCE(ready.ready_count, 0)::integer AS ready_count,
  COALESCE(pressure.waiting_count, 0)::integer AS waiting_count,
  COALESCE(pressure.running_count, 0)::integer AS running_count
FROM pool_capacity pool
JOIN public.workspace workspace ON workspace.id = pool.workspace_id
LEFT JOIN relay_ready ready
  ON ready.workspace_id = pool.workspace_id AND ready.stage_name = pool.stage_name
LEFT JOIN task_pressure pressure
  ON pressure.workspace_id = pool.workspace_id AND pressure.stage_name = pool.stage_name;
