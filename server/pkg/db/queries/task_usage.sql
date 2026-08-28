-- name: UpsertTaskUsage :exec
-- Each provider/model usage row is keyed by (task_id, provider, model,
-- attempt_no) so a task retried across attempts records every attempt as its
-- own attributable row instead of overwriting the previous attempt's counters
-- (PROD-22899). runtime_id and usage_source are recorded so it is clear which
-- worker ran the attempt and whether the numbers are provider-reported or
-- locally estimated. When a newer report for the same (task, provider, model,
-- attempt) arrives (e.g. a corrected token count), it replaces that attempt's
-- row rather than accumulating.
-- Bumps `updated_at` on INSERT and on conflict so the hourly-rollup worker
-- detects the row as dirty and re-aggregates its bucket.
-- Without the conflict-side bump, a correction to historical token counts
-- would never propagate to the rollup.
-- cost_usd_ticks is the provider's own price for this usage (1e-10 USD), NULL
-- when it reports none. It is overwritten like the token counters so a
-- corrected report replaces the previous figure rather than accumulating.
INSERT INTO task_usage (task_id, provider, model, attempt_no, runtime_id, usage_source, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd_ticks, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, sqlc.narg('cost_usd_ticks'), now())
ON CONFLICT (task_id, provider, model, attempt_no)
DO UPDATE SET
    runtime_id = EXCLUDED.runtime_id,
    usage_source = EXCLUDED.usage_source,
    input_tokens = EXCLUDED.input_tokens,
    output_tokens = EXCLUDED.output_tokens,
    cache_read_tokens = EXCLUDED.cache_read_tokens,
    cache_write_tokens = EXCLUDED.cache_write_tokens,
    cost_usd_ticks = EXCLUDED.cost_usd_ticks,
    updated_at = now();

-- name: ListTaskUsageByAttempt :many
-- Per-(task, provider, model, attempt_no) usage for one task — the per-attempt
-- half of per-task cost accounting. A retried task therefore yields one row
-- per attempt (rows share task_id but differ by attempt_no and usually by the
-- runtime that ran them), so per-attempt spend is attributable after the fact.
SELECT task_id, attempt_no, runtime_id, usage_source, provider, model,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd_ticks
FROM task_usage
WHERE task_id = $1
ORDER BY attempt_no, model;

-- name: GetTaskUsage :many
SELECT * FROM task_usage
WHERE task_id = $1
ORDER BY model;

-- name: ListIssueTaskUsage :many
-- Per-(task, provider, model) usage rows for every task on one issue — the
-- per-run half of GetIssueUsageSummary's issue-wide total.
--
-- The model dimension stays on the wire for the same reason the runtime and
-- dashboard usage rows keep it: cost is priced client-side from a per-model
-- rate table, and a row that has collapsed two models into one sum can no
-- longer be priced at all. The execution log sums the rows per task; the usage
-- panel shows them split.
--
-- Ordering is by task then model so the client can group by task_id in one
-- pass.
SELECT
    tu.task_id,
    tu.provider,
    tu.model,
    tu.input_tokens,
    tu.output_tokens,
    tu.cache_read_tokens,
    tu.cache_write_tokens,
    tu.cost_usd_ticks
FROM task_usage tu
JOIN agent_task_queue atq ON atq.id = tu.task_id
WHERE atq.issue_id = $1
ORDER BY tu.task_id, tu.model;

-- name: GetIssueUsageSummary :one
SELECT
    COALESCE(SUM(tu.input_tokens), 0)::bigint AS total_input_tokens,
    COALESCE(SUM(tu.output_tokens), 0)::bigint AS total_output_tokens,
    COALESCE(SUM(tu.cache_read_tokens), 0)::bigint AS total_cache_read_tokens,
    COALESCE(SUM(tu.cache_write_tokens), 0)::bigint AS total_cache_write_tokens,
    COALESCE(SUM(tu.cost_usd_ticks), 0)::bigint AS total_cost_usd_ticks,
    COALESCE(SUM(tu.input_tokens)       FILTER (WHERE tu.cost_usd_ticks IS NULL), 0)::bigint AS uncosted_input_tokens,
    COALESCE(SUM(tu.output_tokens)      FILTER (WHERE tu.cost_usd_ticks IS NULL), 0)::bigint AS uncosted_output_tokens,
    COALESCE(SUM(tu.cache_read_tokens)  FILTER (WHERE tu.cost_usd_ticks IS NULL), 0)::bigint AS uncosted_cache_read_tokens,
    COALESCE(SUM(tu.cache_write_tokens) FILTER (WHERE tu.cost_usd_ticks IS NULL), 0)::bigint AS uncosted_cache_write_tokens,
    COUNT(DISTINCT tu.task_id)::int AS task_count
FROM task_usage tu
JOIN agent_task_queue atq ON atq.id = tu.task_id
WHERE atq.issue_id = $1;

-- name: ListDashboardUsageDaily :many
-- Daily per-(date, provider, model) token aggregates for the workspace, served
-- from the UTC-bucketed `task_usage_hourly` table and
-- sliced to calendar days under the caller-supplied @tz. Optionally
-- scoped to a single project via sqlc.narg('project_id'). Powers the
-- workspace dashboard's daily cost chart.
-- The viewer's tz is applied here at query time, so a viewer in
-- Asia/Shanghai gets their "today" cut at +08 and one in
-- America/Los_Angeles gets theirs at -08 against the same UTC rows.
--
-- @since is already the viewer's local start-of-day-(N) as a UTC
-- instant (computed by parseSinceParamInTZ). It must NOT be re-truncated
-- with DATE_TRUNC here — DATE_TRUNC operates in the session tz and would
-- snap the cutoff back to UTC midnight, dragging in an extra partial
-- local day for any non-UTC viewer.
-- provider is LOWER()-normalized so mixed-case historical rows (written
-- before the handler lowercased provider on write) merge with new rows
-- instead of forming a separate case-variant bucket.
SELECT
    DATE(bucket_hour AT TIME ZONE sqlc.arg('tz')::text) AS date,
    LOWER(provider) AS provider,
    model,
    SUM(input_tokens)::bigint        AS input_tokens,
    SUM(output_tokens)::bigint       AS output_tokens,
    SUM(cache_read_tokens)::bigint   AS cache_read_tokens,
    SUM(cache_write_tokens)::bigint  AS cache_write_tokens,
    SUM(cost_usd_ticks)::bigint                                          AS cost_usd_ticks,
    SUM(COALESCE(uncosted_input_tokens, input_tokens))::bigint           AS uncosted_input_tokens,
    SUM(COALESCE(uncosted_output_tokens, output_tokens))::bigint         AS uncosted_output_tokens,
    SUM(COALESCE(uncosted_cache_read_tokens, cache_read_tokens))::bigint AS uncosted_cache_read_tokens,
    SUM(COALESCE(uncosted_cache_write_tokens, cache_write_tokens))::bigint AS uncosted_cache_write_tokens,
    SUM(task_count)::int             AS task_count
FROM task_usage_hourly
WHERE workspace_id = $1
  AND bucket_hour >= sqlc.arg('since')::timestamptz
  AND (sqlc.narg('project_id')::uuid IS NULL OR project_id = sqlc.narg('project_id'))
GROUP BY DATE(bucket_hour AT TIME ZONE sqlc.arg('tz')::text), LOWER(provider), model
ORDER BY DATE(bucket_hour AT TIME ZONE sqlc.arg('tz')::text) DESC, LOWER(provider), model;

-- name: ListDashboardUsageByAgent :many
-- Per-(agent, provider, model) token aggregates from `task_usage_hourly`. No
-- date grouping in the result, so this query takes no `@tz` — the
-- @since cutoff is a raw timestamptz the Go layer has already computed
-- in the viewer's tz. Model dimension is preserved so the client can
-- compute cost from its per-model pricing table; the client folds rows
-- by agent for the "by agent" list on the dashboard.
--
-- task_count is summed across hourly buckets — one task that spans
-- multiple hours lands in multiple buckets, so this over-counts by
-- hour the same way the daily version over-counted by day. The
-- frontend prefers `ListDashboardAgentRunTime` for the user-facing
-- "tasks" column, so this stays informational only.
-- provider is LOWER()-normalized so mixed-case historical rows merge with
-- new rows (see ListDashboardUsageDaily).
SELECT
    agent_id,
    LOWER(provider) AS provider,
    model,
    SUM(input_tokens)::bigint        AS input_tokens,
    SUM(output_tokens)::bigint       AS output_tokens,
    SUM(cache_read_tokens)::bigint   AS cache_read_tokens,
    SUM(cache_write_tokens)::bigint  AS cache_write_tokens,
    SUM(cost_usd_ticks)::bigint                                          AS cost_usd_ticks,
    SUM(COALESCE(uncosted_input_tokens, input_tokens))::bigint           AS uncosted_input_tokens,
    SUM(COALESCE(uncosted_output_tokens, output_tokens))::bigint         AS uncosted_output_tokens,
    SUM(COALESCE(uncosted_cache_read_tokens, cache_read_tokens))::bigint AS uncosted_cache_read_tokens,
    SUM(COALESCE(uncosted_cache_write_tokens, cache_write_tokens))::bigint AS uncosted_cache_write_tokens,
    SUM(task_count)::int             AS task_count
FROM task_usage_hourly
WHERE workspace_id = $1
  AND bucket_hour >= @since::timestamptz
  AND (sqlc.narg('project_id')::uuid IS NULL OR project_id = sqlc.narg('project_id'))
GROUP BY agent_id, LOWER(provider), model
ORDER BY agent_id, LOWER(provider), model;
