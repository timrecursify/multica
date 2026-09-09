"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { reconcileIssue, reconcileCycle, taskContext, issueCandidatesSql, liveTasksSql, ownerSql, stageAttemptsSql,
  moveToHumanReview, moveToAgentDecision, terminalBlocker, isLeafSql, lifetimeTasksSql, mergedPullRequestNoop,
  armCompletedBuildWorkProduct, stageAttemptBudget } = require("./reconciler.cjs");

const issue = { id: "11111111-1111-4111-8111-111111111111", workspace_id: "22222222-2222-4222-8222-222222222222", status: "Queue", priority: "none" };
const ok = () => ({ ok: true });

test("merged PR check awaits an async GitHub command", async () => {
  let called = false;
  const client = { query: async (sql) => {
    if (sql.startsWith("SELECT content FROM comment")) {
      return { rows: [{ content: "PR https://github.com/acme/widget/pull/7" }] };
    }
    return { rows: [] };
  }};
  const result = await mergedPullRequestNoop(client, { id: issue.id, status: "In Progress" }, {
    githubCommand: async () => {
      await Promise.resolve();
      called = true;
      return JSON.stringify({ state: "MERGED", mergedAt: "2026-09-03T00:00:00Z", url: "https://github.com/acme/widget/pull/7" });
    }, evaluate: ok
  });
  assert.equal(called, true);
  assert.equal(result.action, "no_op");
});

function harness({ live = [], isLeaf = true, owner = {
  agent_id: "33333333-3333-4333-8333-333333333333",
  selected_runtime_id: "44444444-4444-4444-8444-444444444444"
} } = {}) {
  const calls = []; let inserted = 0;
  return { calls, query: async (sql, values = []) => {
    calls.push({ sql, values });
    if (sql.includes("AS is_leaf")) return { rows: [{ is_leaf: isLeaf }] };
    if (sql.startsWith("SELECT id, workspace_id, status")) return { rows: [issue] };
    if (sql.includes("FROM agent_task_queue") && sql.includes("FOR UPDATE")) return { rows: live };
    if (sql.includes("FROM relay_stage_agent_pool")) return { rows: owner ? [owner] : [] };
    if (sql.includes("INSERT INTO agent_task_queue")) return { rows: [{ id: `task-${++inserted}` }] };
    return { rows: [] };
  }};
}

test("query builders hold the live status invariant", () => {
  assert.match(issueCandidatesSql(), /status = ANY/);
  assert.match(issueCandidatesSql(), /NOT EXISTS \(SELECT 1 FROM issue c/);
  assert.doesNotMatch(issueCandidatesSql(), /parent_issue_id IS NULL/);
  assert.match(isLeafSql(), /AS is_leaf/);
  assert.match(liveTasksSql(), /FOR UPDATE/);
  assert.match(ownerSql(), /COALESCE\(own_runtime.id, online_runtime.id\) AS selected_runtime_id/);
  assert.match(ownerSql(), /a.archived_at IS NULL/);
  assert.match(ownerSql(), /a.status IN \('idle', 'working'\)/);
  assert.match(ownerSql(), /COALESCE\(own_runtime.id, online_runtime.id\) IS NOT NULL/);
  assert.match(ownerSql(), /task.status = 'running'/);
  assert.match(ownerSql(), /COALESCE\(running.task_count, 0\) < a.max_concurrent_tasks/);
  assert.match(ownerSql(), /available_capacity/);
  assert.match(ownerSql(), /ORDER BY pool.last_selected_at NULLS FIRST, pool.agent_id LIMIT 1/);
  assert.match(stageAttemptsSql(), /\$3::int/);
  assert.match(stageAttemptsSql(), /created_at >= GREATEST/);
  assert.match(stageAttemptsSql(), /from_stage IS DISTINCT FROM to_stage/);
  assert.match(stageAttemptsSql(), /parked_release_at/);
  assert.match(stageAttemptsSql(), /human_review_release_at/);
  assert.match(stageAttemptsSql(), /failure_reason = ANY/);
  assert.match(stageAttemptsSql(), /provider_quota_limit/);
  assert.deepEqual(taskContext("Queue"), { source: "reconcile", kind: "stage_task", to_stage: "Queue" });
});

test("infrastructure failures do not increment the stage attempt aggregate", () => {
  const sql = stageAttemptsSql();
  assert.match(sql, /NOT \(failure_reason = ANY/);
  assert.match(sql, /'runtime_offline'/);
  assert.match(sql, /'timeout'/);
  assert.match(sql, /failure_reason ~\* '[^']*402/);
});

test("genuine failures remain eligible for the stage attempt aggregate", () => {
  const sql = stageAttemptsSql();
  assert.doesNotMatch(sql, /failed_implementation/);
  assert.match(sql, /failure_reason = ANY/);
  assert.match(sql, /failure_reason ~\*/);
});

test("infrastructure exclusion remains inside the arrival window", () => {
  const sql = stageAttemptsSql();
  assert.ok(sql.indexOf("failure_reason = ANY") < sql.indexOf("created_at >= GREATEST"));
  assert.match(sql, /from_stage IS DISTINCT FROM/);
});

test("stage attempt window excludes tasks before arrival and includes tasks after it", () => {
  const sql = stageAttemptsSql();
  assert.match(sql, /context->>'to_stage' = \$2/);
  assert.match(sql, /created_at >= GREATEST/);
  assert.match(sql, /max\(created_at\) FROM relay_run_log/);
});

test("stage attempt window uses the later release timestamp", () => {
  const sql = stageAttemptsSql();
  assert.match(sql, /GREATEST\([\s\S]*parked_release_at[\s\S]*human_review_release_at/);
});

test("stage attempt ceiling stays fixed across replays", () => {
  assert.deepEqual(stageAttemptBudget(0, 2, 2), { attempt: 1, maxAttempts: 2 });
  assert.deepEqual(stageAttemptBudget(1, 2, 2), { attempt: 2, maxAttempts: 2 });
  assert.deepEqual(stageAttemptBudget(2, 2, 2), { attempt: 3, maxAttempts: 2 });
  assert.deepEqual(stageAttemptBudget(0, 0, 2), { attempt: 1, maxAttempts: 2 });
});

test("zero-task issue creates exactly one reconcile task and pending log", async () => {
  const db = harness();
  const result = await reconcileIssue(db, issue.id, { evaluate: ok });
  assert.deepEqual(result, { action: "created", taskId: "task-1" });
  const insert = db.calls.find((call) => call.sql.includes("INSERT INTO agent_task_queue"));
  assert.equal(insert.values[1], "44444444-4444-4444-8444-444444444444");
  assert.equal(JSON.parse(insert.values[5]).source, "reconcile");
  assert.ok(db.calls.some((call) => call.sql.includes("UPDATE relay_stage_agent_pool SET last_selected_at = NOW()")));
  assert.ok(db.calls.some((call) => call.sql.includes("INSERT INTO relay_run_log")));
});

test("completed task with failed outcome is repaired instead of cooling down the stage", async () => {
  const db = harness();
  const original = db.query;
  db.query = async (sql, values = []) => {
    if (sql.includes("SELECT id, status, result, error FROM agent_task_queue")) {
      return { rows: [{ id: "task-poisoned", status: "completed", result: JSON.stringify({ output: "OUTCOME: FAILED\nmultica: command not found" }), error: null }] };
    }
    return original(sql, values);
  };
  assert.deepEqual(await reconcileIssue(db, issue.id, { evaluate: ok }), {
    action: "skipped", reason: "completion_failed", taskId: "task-poisoned"
  });
  const repair = db.calls.find((call) => call.sql.includes("SET status = 'failed'"));
  assert.ok(repair, "poisoned completion should be persisted as failed");
  assert.equal(repair.values[1], "completion_failed");
});

test("completed task with a machine blocker remains completed for typed outcome recording", async () => {
  const db = harness();
  const original = db.query;
  db.query = async (sql, values = []) => {
    if (sql.includes("SELECT id, status, result, error FROM agent_task_queue")) {
      return { rows: [{ id: "task-blocked", status: "completed",
        result: JSON.stringify({ output: "OUTCOME: BLOCKED blocked_on=ci" }), error: null }] };
    }
    return original(sql, values);
  };
  assert.deepEqual(await reconcileIssue(db, issue.id, { evaluate: ok }), {
    action: "skipped", reason: "completion_blocked", blockedOn: "ci", taskId: "task-blocked"
  });
  assert.equal(db.calls.some((call) => call.sql.includes("SET status = 'failed'")), false);
});

test("restart is idempotent when the current-stage task is live", async () => {
  const db = harness({ live: [{ id: "task-live", status: "queued", context: taskContext("Queue") }] });
  assert.deepEqual(await reconcileIssue(db, issue.id, { evaluate: ok }), { action: "already_live", taskId: "task-live" });
  assert.equal(db.calls.some((call) => call.sql.includes("INSERT INTO agent_task_queue")), false);
});

test("completed build work product is handed off once without another task", async () => {
  const completed = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  let relayArmed = false;
  let handoff;
  const db = harness();
  const original = db.query;
  db.query = async (sql, values = []) => {
    if (sql.startsWith("SELECT id, workspace_id, status")) {
      return { rows: [{ ...issue, status: "In Progress" }] };
    }
    if (sql.includes("SELECT task.id, task.completed_at")) {
      return { rows: [{ id: completed, completed_at: "2026-09-06T00:00:00Z" }] };
    }
    if (sql.includes("FROM qc_effective_verdict")) return { rows: [] };
    if (sql.includes("INSERT INTO relay_run_log") && sql.includes("NOT EXISTS")) {
      handoff = { sql, values };
      if (relayArmed) return { rows: [] };
      relayArmed = true;
      return { rows: [{ task_id: completed }] };
    }
    return original(sql, values);
  };

  assert.deepEqual(await reconcileIssue(db, issue.id, { evaluate: ok }),
    { action: "handoff", taskId: completed });
  assert.equal(db.calls.some((call) => call.sql.includes("INSERT INTO agent_task_queue")), false);
  const priorLogUpdate = db.calls.find((call) => call.sql.includes("UPDATE relay_run_log SET task_id = NULL"));
  assert.match(priorLogUpdate.sql, /status = 'completed'/);
  assert.match(priorLogUpdate.sql, /to_stage IS DISTINCT FROM \$2::text/);
  assert.match(handoff.sql, /AND NOT EXISTS/);

  assert.deepEqual(await reconcileIssue(db, issue.id, { evaluate: ok }), {
    action: "reused", taskId: completed, reason: "completed_build_work_product"
  });
  assert.equal(db.calls.filter((call) => call.sql.includes("INSERT INTO agent_task_queue")).length, 0);
});

test("completed build handoff statement runs against the production relay_run_log indexes", async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for the real PostgreSQL regression test");
  const { Client } = require("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  const schema = `reconciler_${process.pid}_${Date.now()}`;
  const completed = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(`CREATE TABLE agent_task_queue (
      id uuid PRIMARY KEY, issue_id uuid NOT NULL, agent_id uuid, status text NOT NULL
    )`);
    await client.query(`CREATE TABLE relay_run_log (
      id bigserial PRIMARY KEY, issue_id uuid NOT NULL, from_stage text NOT NULL,
      to_stage text, agent_id uuid, task_id uuid, status text NOT NULL DEFAULT 'pending',
      parked_audit jsonb, created_at timestamptz NOT NULL DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE issue_stage_outcome (
      issue_id uuid NOT NULL, stage text NOT NULL, task_id uuid
    )`);
    await client.query("CREATE INDEX idx_relay_run_log_issue_id ON relay_run_log (issue_id)");
    const indexes = await client.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'relay_run_log' ORDER BY indexname",
      [schema]
    );
    assert.deepEqual(indexes.rows.map((row) => row.indexname),
      ["idx_relay_run_log_issue_id", "relay_run_log_pkey"]);
    await client.query(
      "INSERT INTO agent_task_queue (id, issue_id, agent_id, status) VALUES ($1, $2, $3, 'completed')",
      [completed, issue.id, "33333333-3333-4333-8333-333333333333"]
    );
    await client.query(
      "INSERT INTO relay_run_log (issue_id, from_stage, to_stage, task_id, status) VALUES ($1, 'Spec', 'Queue', $2, 'completed')",
      [issue.id, completed]
    );
    const first = await armCompletedBuildWorkProduct(client, issue.id, "In Progress", completed);
    const second = await armCompletedBuildWorkProduct(client, issue.id, "In Progress", completed);
    assert.equal(first.rowCount, 1);
    assert.equal(second.rowCount, 0);
    const rows = await client.query(
      "SELECT to_stage, task_id, status FROM relay_run_log ORDER BY id"
    );
    assert.deepEqual(rows.rows, [
      { to_stage: "Queue", task_id: null, status: "completed" },
      { to_stage: "In Progress", task_id: completed, status: "pending" }
    ]);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  }
});

test("stale pending completed-build handoff is detected instead of silently reused", async () => {
  const calls = [];
  const client = { async query(sql, values) {
    calls.push({ sql, values });
    if (sql.includes("SELECT task_id FROM relay_run_log")) return { rows: [{ task_id: "stale-task" }] };
    return { rows: [], rowCount: 0 };
  }};
  const result = await armCompletedBuildWorkProduct(client, "issue", "In Progress", "stale-task", 30);
  assert.equal(result.stalled, true);
  const detection = calls.find(({ sql }) => sql.includes("SELECT task_id FROM relay_run_log"));
  assert.match(detection.sql, /status = 'pending'/);
  assert.match(detection.sql, /created_at <= NOW\(\) -/);
  assert.equal(detection.values[3], 30);
});

test("stale pending completed-build handoff routes to agent-owned Spec", async () => {
  const completed = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const db = harness();
  const original = db.query;
  db.query = async (sql, values = []) => {
    if (sql.startsWith("SELECT id, workspace_id, status")) {
      return { rows: [{ ...issue, status: "In Progress" }] };
    }
    if (sql.includes("SELECT task.id, task.completed_at")) {
      return { rows: [{ id: completed, completed_at: "2026-09-06T00:00:00Z" }] };
    }
    if (sql.includes("FROM qc_effective_verdict")) return { rows: [] };
    if (sql.includes("SELECT task_id FROM relay_run_log")) return { rows: [{ task_id: completed }] };
    return original(sql, values);
  };
  assert.deepEqual(await reconcileIssue(db, issue.id, { evaluate: ok }), {
    action: "agent_decision", reason: "completed_build_work_product_handoff_stalled", status: "Spec"
  });
  assert.ok(db.calls.some(({ sql }) => sql.includes("UPDATE issue SET status = 'Spec'")));
  assert.equal(db.calls.some(({ sql }) => sql.includes("UPDATE issue SET status = 'Human Review'")), false);
  assert.equal(db.calls.some(({ sql }) => sql.includes("INSERT INTO agent_task_queue")), false);
});

test("completed same-stage handoff is rearmed when the outcome cites an older task", async () => {
  const calls = [];
  const client = { async query(sql, values) {
    calls.push({ sql, values });
    if (sql.includes("UPDATE relay_run_log completed")) return { rows: [{ task_id: "new-task" }], rowCount: 1 };
    if (sql.includes("UPDATE relay_run_log SET task_id = NULL")) return { rows: [], rowCount: 0 };
    throw new Error(`unexpected SQL: ${sql}`);
  }};
  const result = await armCompletedBuildWorkProduct(client, "issue", "In Progress", "new-task");
  assert.deepEqual(result.rows, [{ task_id: "new-task" }]);
  const rearm = calls.find(({ sql }) => sql.includes("UPDATE relay_run_log completed"));
  assert.match(rearm.sql, /completed\.status = 'completed'/);
  assert.match(rearm.sql, /outcome\.task_id = \$3::uuid/);
  assert.equal(calls.some(({ sql }) => sql.includes("INSERT INTO relay_run_log")), false);
});

test("own-stage FAILED build with no QC verdict is admitted as a bounded retry in PostgreSQL", async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for the real PostgreSQL regression test");
  const { Client } = require("pg");
  const { buildTaskAdmission } = require("./build-admission.cjs");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  const schema = `build_admission_${process.pid}_${Date.now()}`;
  const issueId = "11111111-1111-4111-8111-111111111111";
  const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(`CREATE TABLE agent_task_queue (
      id uuid PRIMARY KEY, issue_id uuid NOT NULL, status text NOT NULL,
      context jsonb NOT NULL, result jsonb, completed_at timestamptz, created_at timestamptz NOT NULL,
      retry_of_task_id uuid
    )`);
    await client.query(`CREATE TABLE qc_effective_verdict (
      id bigserial PRIMARY KEY, issue_id uuid NOT NULL, verdict text NOT NULL,
      failure_class text, qualifying boolean, created_at timestamptz NOT NULL
    )`);
    await client.query(`CREATE TABLE issue_stage_outcome (
      issue_id uuid NOT NULL, stage text NOT NULL, outcome text NOT NULL,
      blocked_on text, task_id uuid, outcome_at timestamptz NOT NULL
    )`);
    await client.query(`CREATE TABLE issue_work_product (
      issue_id uuid NOT NULL, scope_revision bigint NOT NULL, kind text NOT NULL,
      repository text, branch text, pr_number integer, head_sha text,
      acceptance_evidence jsonb NOT NULL, replaces_scope_revision bigint,
      consuming_stage text NOT NULL, dependency_issue_ids uuid[] NOT NULL DEFAULT '{}',
      status text NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
    )`);
    await client.query(
      `INSERT INTO issue_work_product
         (issue_id, scope_revision, kind, repository, branch, pr_number, head_sha,
          acceptance_evidence, consuming_stage, status, created_at, updated_at)
       VALUES ($1, 1, 'implementation', 'acme/widget', 'fix/belt', 7, $2,
         '{"task_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}',
         'In Review', 'active', '2026-09-07T20:00:00Z', '2026-09-07T20:00:00Z')`,
      [issueId, "a".repeat(40)]
    );
    await client.query(
      `INSERT INTO agent_task_queue
         (id, issue_id, status, context, result, completed_at, created_at)
       VALUES ($1, $2, 'completed', '{"to_stage":"In Progress"}',
         '{"output":"work product https://github.com/acme/widget/pull/7\\nOUTCOME: FAILED"}',
         '2026-09-07T20:00:00Z', '2026-09-07T19:00:00Z')`, [taskId, issueId]);
    await client.query(
      `INSERT INTO issue_stage_outcome (issue_id, stage, outcome, blocked_on, task_id, outcome_at)
       VALUES ($1, 'In Progress', 'FAILED', NULL, $2, '2026-09-07T20:00:01Z')`,
      [issueId, taskId]);

    assert.deepEqual(await buildTaskAdmission(client, {
      issueId, toStage: "In Progress"
    }), { admit: true, retryOfTaskId: taskId });

    await client.query(
      `INSERT INTO qc_effective_verdict
         (issue_id, verdict, failure_class, qualifying, created_at)
       VALUES ($1, 'FAIL', 'evidence', false, '2026-09-07T20:00:02Z')`, [issueId]);
    assert.deepEqual(await buildTaskAdmission(client, {
      issueId, toStage: "In Progress"
    }), { admit: true, retryOfTaskId: taskId });
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  }
});

test("completed build without a work product remains admitted", async () => {
  const db = harness();
  assert.deepEqual(await reconcileIssue(db, issue.id, { evaluate: ok }),
    { action: "created", taskId: "task-1" });
  assert.equal(db.calls.some((call) => call.sql.includes("ON CONFLICT (task_id)")), false);
});

test("existing implementation retry remains reused without a relay handoff", async () => {
  const prior = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const retry = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const db = harness();
  const original = db.query;
  db.query = async (sql, values = []) => {
    if (sql.startsWith("SELECT id, workspace_id, status")) {
      return { rows: [{ ...issue, status: "In Progress" }] };
    }
    if (sql.includes("SELECT task.id, task.completed_at")) {
      return { rows: [{ id: prior, completed_at: "2026-09-06T00:00:00Z" }] };
    }
    if (sql.includes("FROM qc_effective_verdict")) return { rows: [{ id: "qc-1" }] };
    if (sql.includes("retry_of_task_id=$2::uuid")) return { rows: [{ id: retry }] };
    return original(sql, values);
  };
  assert.deepEqual(await reconcileIssue(db, issue.id, { evaluate: ok }), {
    action: "reused", taskId: retry, reason: "implementation_retry_exists"
  });
  assert.equal(db.calls.some((call) => call.sql.includes("ON CONFLICT (task_id)")), false);
  assert.equal(db.calls.some((call) => call.sql.includes("INSERT INTO agent_task_queue")), false);
});

test("rollups with open children and running old-stage tasks are skipped", async () => {
  const rollup = harness({ isLeaf: false });
  assert.deepEqual(await reconcileIssue(rollup, issue.id, { evaluate: ok }),
    { action: "skipped", reason: "rollup_has_open_children" });
  assert.equal(rollup.calls.some((call) => call.sql.includes("INSERT INTO agent_task_queue")), false);
  const leafChild = harness();
  const childOriginal = leafChild.query;
  leafChild.query = async (sql, values = []) =>
    sql.startsWith("SELECT id, workspace_id, status, priority, metadata, qc_fail_count, parent_issue_id")
      ? { rows: [{ ...issue, parent_issue_id: "parent" }] } : childOriginal(sql, values);
  assert.deepEqual(await reconcileIssue(leafChild, issue.id, { evaluate: ok }), { action: "created", taskId: "task-1" });
  const stale = harness({ live: [{ id: "old", status: "running", context: taskContext("Spec") }] });
  assert.deepEqual(await reconcileIssue(stale, issue.id, { evaluate: ok }), { action: "skipped", reason: "stale_stage_running" });
});

test("insert conflict is already-live and budgets bound creation", async () => {
  const conflict = harness();
  const original = conflict.query;
  conflict.query = async (sql, values) => sql.includes("INSERT INTO agent_task_queue") ? { rows: [] } : original(sql, values);
  assert.deepEqual(await reconcileIssue(conflict, issue.id, { evaluate: ok }), { action: "already_live" });
  const db = harness();
  assert.equal((await reconcileIssue(db, issue.id, { evaluate: ok, maxCreatePerCycle: 1,
    budget: { created: 1, byAgent: new Map() } })).reason, "creation_budget");
  assert.equal(db.calls.some((call) => call.sql.includes("INSERT INTO agent_task_queue")), false);
});

test("zero cycle limit creates no task or relay log", async () => {
  const db = harness();
  const result = await reconcileIssue(db, issue.id, {
    evaluate: ok,
    maxCreatePerCycle: 0,
    budget: { created: 0, byAgent: new Map() }
  });
  assert.deepEqual(result, { action: "skipped", reason: "creation_budget" });
  assert.equal(db.calls.some((call) => call.sql.includes("INSERT INTO agent_task_queue")), false);
  assert.equal(db.calls.some((call) => call.sql.includes("INSERT INTO relay_run_log")), false);
});

test("cycle returns per-issue results", async () => {
  const db = harness();
  const original = db.query;
  db.query = async (sql, values) => sql.startsWith("SELECT i.id, i.workspace_id, i.status, i.priority, i.metadata, i.qc_fail_count\n            FROM issue i WHERE")
    ? { rows: [issue] } : original(sql, values);
  assert.deepEqual(await reconcileCycle(db, { evaluate: ok }), [{ action: "created", taskId: "task-1" }]);
});

test("cycle rolls back a throwing issue and reconciles the next issue", async () => {
  const second = { ...issue, id: "77777777-7777-4777-8777-777777777777" };
  const db = harness();
  const original = db.query;
  db.query = async (sql, values = []) => {
    if (sql.startsWith("SELECT i.id, i.workspace_id, i.status, i.priority, i.metadata, i.qc_fail_count\n            FROM issue i WHERE")) {
      return { rows: [issue, second] };
    }
    if (sql.startsWith("SELECT id, workspace_id, status, priority, metadata, qc_fail_count, parent_issue_id") &&
        values[0] === issue.id) throw new Error("first issue fails");
    return original(sql, values);
  };
  const results = await reconcileCycle(db, { evaluate: ok });
  assert.deepEqual(results, [
    { action: "error", issueId: issue.id, message: "first issue fails" },
    { action: "created", taskId: "task-1" }
  ]);
  assert.ok(db.calls.some((call) => call.sql === "ROLLBACK"));
  assert.ok(db.calls.some((call) => call.sql.includes("INSERT INTO agent_task_queue")));
});

test("per-stage attempt ceiling remains fixed across a new task", async () => {
  const db = harness();
  const original = db.query;
  db.query = async (sql, values) => sql.includes("max(attempt)")
    ? { rows: [{ attempt: 2, max_attempts: 2 }] } : original(sql, values);
  assert.deepEqual(await reconcileIssue(db, issue.id, { evaluate: ok }), { action: "created", taskId: "task-1" });
  const insert = db.calls.find((call) => call.sql.includes("INSERT INTO agent_task_queue"));
  assert.equal(insert.values[7], 3);
  assert.equal(insert.values[8], 2);
});

test("typed outcome eligibility runs before creating a retry task", async () => {
  const db = harness();
  const original = db.query;
  db.query = async (sql, values = []) => {
    if (sql.startsWith("SELECT id, workspace_id, status")) return { rows: [{ ...issue, status: "In Progress" }] };
    if (sql.includes("FROM issue_stage_outcome")) {
      return { rows: [{ outcome: "FAILED", blocked_on: null, input_hash: "h1", outcome_at: "2026-09-05T19:00:00Z" }] };
    }
    if (sql.includes("SELECT md5(concat_ws")) return { rows: [{ input_hash: "h1" }] };
    if (sql.includes("max(attempt)")) return { rows: [{ attempt: 0, max_attempts: 2 }] };
    return original(sql, values);
  };
  const result = await reconcileIssue(db, issue.id, {
    evaluate: ok,
    typedOutcomes: true,
    failedTtlMinutes: 15
  });
  assert.deepEqual(result, { action: "created", taskId: "task-1" });
});

test("two reconciler sessions converge on one task", async () => {
  const shared = { live: [], lock: Promise.resolve(), sequence: 0 };
  const session = () => {
    let unlock;
    return { query: async (sql, values = []) => {
      if (sql.includes("pg_advisory_xact_lock")) {
        const prior = shared.lock;
        shared.lock = new Promise((resolve) => { unlock = resolve; });
        await prior;
        return { rows: [] };
      }
      if (sql === "COMMIT") { unlock?.(); return { rows: [] }; }
      if (sql.includes("AS is_leaf")) return { rows: [{ is_leaf: true }] };
      if (sql.startsWith("SELECT id, workspace_id, status")) return { rows: [issue] };
      if (sql.includes("FROM agent_task_queue") && sql.includes("FOR UPDATE")) return { rows: shared.live };
      if (sql.includes("FROM relay_stage_agent_pool")) return { rows: [{
        agent_id: "33333333-3333-4333-8333-333333333333",
        selected_runtime_id: "44444444-4444-4444-8444-444444444444"
      }] };
      if (sql.includes("INSERT INTO agent_task_queue")) {
        const row = { id: `task-${++shared.sequence}`, status: "queued", context: JSON.parse(values[5]) };
        shared.live.push(row); return { rows: [row] };
      }
      return { rows: [] };
    }};
  };
  const results = await Promise.all([reconcileIssue(session(), issue.id, { evaluate: ok }), reconcileIssue(session(), issue.id, { evaluate: ok })]);
  assert.deepEqual(results.map((result) => result.action), ["created", "already_live"]);
  assert.equal(shared.live.length, 1);
});

test("duplicate live tasks cancel unstarted extras and keep one", async () => {
  const db = harness({ live: ["a", "b"].map((id) => ({ id, status: "queued", context: taskContext("Queue") })) });
  assert.deepEqual(await reconcileIssue(db, issue.id, { evaluate: ok }), {
    action: "already_live", taskId: "a", cancelledDuplicates: 1
  });
  const cancelled = db.calls.find((call) => call.sql.includes("failure_reason = 'reconcile_duplicate'"));
  assert.deepEqual(cancelled.values, [["b"]]);
});

test("missing owner skips the issue without a new task", async () => {
  const missing = harness({ owner: null });
  assert.deepEqual(await reconcileIssue(missing, issue.id, { evaluate: ok }), { action: "skipped", reason: "unresolved_owner" });
  assert.equal(missing.calls.some((call) => call.sql.includes("INSERT INTO agent_task_queue")), false);
});

test("agent without a runtime is skipped for the next eligible pool agent", async () => {
  const db = harness({ owner: {
    agent_id: "55555555-5555-4555-8555-555555555555",
    selected_runtime_id: "66666666-6666-4666-8666-666666666666"
  }});
  const result = await reconcileIssue(db, issue.id, { evaluate: ok });
  assert.equal(result.action, "created");
  const insert = db.calls.find((call) => call.sql.includes("INSERT INTO agent_task_queue"));
  assert.equal(insert.values[0], "55555555-5555-4555-8555-555555555555");
  assert.equal(insert.values[1], "66666666-6666-4666-8666-666666666666");
});

// A recorded BLOCKED outcome only leaves the belt when nothing observable remains.
// FAILED/human is equally terminal: only a person can resolve it, regardless of
// which terminal outcome label the worker recorded.
test("terminalBlocker routes only unobservable blockers", async () => {
  const unlinked = { query: async () => ({ rows: [] }) };
  const linked = { query: async () => ({ rows: [{ "?column?": 1 }] }) };
  const b = (outcome, blocked_on) => ({ outcome, blocked_on });

  assert.equal(await terminalBlocker(unlinked, issue, b("BLOCKED", "human")), "blocked_human");
  assert.equal(await terminalBlocker(linked, issue, b("BLOCKED", "human")), "blocked_human");
  assert.equal(await terminalBlocker(unlinked, issue, b("FAILED", "human")), "blocked_human");
  assert.equal(await terminalBlocker(unlinked, issue, b("BLOCKED", "ci")), "blocked_ci_unobservable");
  assert.equal(await terminalBlocker(unlinked, issue, b("BLOCKED", "sha")), "blocked_sha_unobservable");
  assert.equal(await terminalBlocker(unlinked, issue, b("BLOCKED", "dependency")), "blocked_dependency_unobservable");
  // A linked PR or dependency still supplies a hash term, so the belt keeps it.
  assert.equal(await terminalBlocker(linked, issue, b("BLOCKED", "ci")), null);
  assert.equal(await terminalBlocker(linked, issue, b("BLOCKED", "dependency")), null);
  // quota clears itself. FAILED only routes for a human blocker: ci, sha, and
  // dependency retain machine-observable inputs and are not widened here.
  assert.equal(await terminalBlocker(unlinked, issue, b("BLOCKED", "quota")), null);
  assert.equal(await terminalBlocker(unlinked, issue, b("FAILED", null)), null);
  assert.equal(await terminalBlocker(unlinked, issue, b("FAILED", "ci")), null);
  assert.equal(await terminalBlocker(unlinked, issue, b("FAILED", "sha")), null);
  assert.equal(await terminalBlocker(unlinked, issue, b("FAILED", "dependency")), null);
  assert.equal(await terminalBlocker(unlinked, issue, null), null);
});

// ---------------------------------------------------------------------------
// Relay-row consumability invariant.
//
// A pending relay_run_log row is a work item. Exactly three paths can ever close
// one, and each is read below from the source that implements it rather than
// restated here, so this test tracks the consumers instead of a copy of them:
//
//   1. findAndAdvanceTasks   - INNER JOIN agent_task_queue atq ON rrl.task_id =
//                              atq.id, so a NULL task_id can never match.
//   2. closeDeadRelayRows    - closes pending rows whose to_stage is terminal.
//   3. cleanupStalePendingRows - closes a row only once the issue has moved PAST
//                              the row's to_stage, so a producer that parks the
//                              issue ON that stage can never satisfy it.
//
// A producer that trips all three writes a row nothing will ever close.
const fs = require("node:fs");
const path = require("node:path");
const DAEMON_SRC = fs.readFileSync(path.join(__dirname, "parity", "multica-relay-advance-daemon.cjs"), "utf8");
const DEAD_ROWS_SRC = fs.readFileSync(path.join(__dirname, "parity", "relay-dead-rows.cjs"), "utf8");

// Split a SQL VALUES list on top-level commas so jsonb_build_object(a, b) stays whole.
function splitTopLevel(text) {
  const parts = []; let depth = 0, quoted = false, current = "";
  for (const ch of text) {
    if (ch === "'") quoted = !quoted;
    if (!quoted && ch === "(") depth += 1;
    if (!quoted && ch === ")") depth -= 1;
    if (!quoted && depth === 0 && ch === ",") { parts.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

// The row a producer actually writes, read out of the SQL it issued.
function producedRelayRow(calls) {
  const insert = calls.find((c) => /INSERT INTO relay_run_log/.test(c.sql || ""));
  assert.ok(insert, "producer issued no INSERT INTO relay_run_log");
  const columns = splitTopLevel(insert.sql.match(/relay_run_log\s*\(([\s\S]*?)\)\s*\n?\s*VALUES/i)[1]);
  const values = splitTopLevel(insert.sql.match(/VALUES\s*\(([\s\S]*)\)/i)[1]);
  assert.equal(columns.length, values.length, "column/value arity mismatch in producer SQL");
  const row = {};
  columns.forEach((name, i) => { row[name] = values[i]; });
  const literal = (v) => (v && /^'(.*)'$/.test(v) ? v.slice(1, -1) : null);
  return { columns, status: literal(row.status), toStage: literal(row.to_stage) };
}

// Why, if at all, the produced row is unclosable. Empty means consumable.
function strandedReasons(row, issueParkedAt) {
  if (row.status !== "pending") return [];
  const reasons = [];
  const taskCorrelated = /INNER JOIN relay_run_log rrl ON rrl\.task_id = atq\.id AND rrl\.status = \$1/;
  assert.match(DAEMON_SRC, taskCorrelated, "findAndAdvanceTasks no longer joins on rrl.task_id; update this invariant");
  if (!row.columns.includes("task_id")) reasons.push("no task_id: findAndAdvanceTasks can never join it");

  assert.match(DEAD_ROWS_SRC, /WHERE status = 'pending'\s*\n\s*AND to_stage = ANY\(\$1\)/,
    "closeDeadRelayRows no longer sweeps by terminal to_stage; update this invariant");
  const terminal = DAEMON_SRC.match(/const TERMINAL_STAGES = new Set\(\[([^\]]*)\]\)/)[1]
    .split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
  if (!terminal.includes(row.toStage)) reasons.push(`to_stage '${row.toStage}' is not terminal: closeDeadRelayRows skips it`);

  assert.match(DAEMON_SRC, /AND rsc\.stage_name = rrl\.to_stage\s*\n\s*AND i\.status = rsc\.next_stage/,
    "cleanupStalePendingRows no longer requires the issue past to_stage; update this invariant");
  if (issueParkedAt === row.toStage) reasons.push(`issue is parked on '${row.toStage}': cleanupStalePendingRows waits for the stage after it`);
  return reasons;
}

// Fails on the pre-fix producer, which wrote 'pending' with no task_id for a
// transition it had already performed itself, parking the issue on the row's own
// to_stage. That stranded 195 Spec -> Human Review rows measured on gsp 2026-09-07.
test("moveToHumanReview cannot strand an unconsumable pending relay row", async () => {
  const calls = [];
  const db = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: [] }; } };
  await moveToHumanReview(db, { ...issue, status: "Spec" }, "blocked_dependency_unobservable", { evaluate: ok });

  // The producer performs the advance itself, so the issue is parked on to_stage.
  const moved = calls.find((c) => /UPDATE issue SET status = 'Human Review'/.test(c.sql || ""));
  assert.ok(moved, "moveToHumanReview must perform the advance itself");

  const row = producedRelayRow(calls);
  assert.deepEqual(strandedReasons(row, "Human Review"), [],
    "moveToHumanReview wrote a relay row no consumer can ever close");
});

test("moveToHumanReview asks as the operator the belt acts for", async () => {
  const seen = [];
  const db = { query: async (sql, values) => { seen.push({ sql, values }); return { rows: [] }; } };
  const result = await moveToHumanReview(db, issue, "blocked_human", {
    evaluate: (input) => { seen.push({ evaluate: input }); return { ok: true }; }
  });
  assert.deepEqual(result, { action: "human_review", reason: "blocked_human" });
  const call = seen.find((s) => s.evaluate).evaluate;
  // Every `* -> Human Review` row in transition-policy lists actors ['operator'];
  // 'system' was refused as actor_denied, which left the function unusable.
  assert.equal(call.actor, "operator");
  assert.equal(call.to, "Human Review");
  assert.deepEqual(call.evidence, { blocker: "blocked_human" });
  assert.ok(seen.some((s) => /multica.relay_authorized/.test(s.sql || "")));
  assert.ok(seen.some((s) => /UPDATE issue SET status = 'Human Review'/.test(s.sql || "")));
  assert.ok(seen.some((s) => /INSERT INTO relay_run_log/.test(s.sql || "")));
});

test("a technical lifetime cap routes to agent-owned Spec, never Human Review", async () => {
  const { evaluate } = require("./transition-policy.cjs");
  const verdict = evaluate({
    from: "Queue", to: "Spec", actor: "system",
    evidence: { retry_escalation: true, blocker: "lifetime_task_limit:33/6" }
  });
  assert.equal(verdict.ok, true);

  const seen = [];
  const db = { query: async (sql, values) => { seen.push({ sql, values }); return { rows: [] }; } };
  const result = await moveToAgentDecision(
    db, { ...issue, status: "Queue" }, "lifetime_task_limit:33/6", { evaluate }
  );
  assert.deepEqual(result, { action: "agent_decision", reason: "lifetime_task_limit:33/6", status: "Spec" });
  assert.ok(seen.some((s) => /UPDATE issue SET status = 'Spec'/.test(s.sql || "")));
  assert.equal(seen.some((s) => /UPDATE issue SET status = 'Human Review'/.test(s.sql || "")), false);
  const logged = seen.find((s) => /INSERT INTO relay_run_log/.test(s.sql || ""));
  assert.equal(logged.values[1], "Queue");
});

test("a policy rejection leaves the issue skipped rather than erroring the cycle", async () => {
  const db = harness();
  db.query = async (sql, values = []) => {
    if (sql.startsWith("SELECT id, workspace_id, status")) return { rows: [issue] };
    if (sql.includes("FROM agent_task_queue") && sql.includes("FOR UPDATE")) return { rows: [] };
    return { rows: [] };
  };
  await assert.rejects(
    () => moveToHumanReview(db, issue, "blocked_human", { evaluate: () => ({ ok: false, code: "actor_denied" }) }),
    /actor_denied/
  );
});

// The issue's own comments are machine-observable evidence. A builder that
// opened a PR records its URL there, so a missing issue_pull_request row is a
// gap in our bookkeeping, not proof the stage can never re-open.
function commentHarness(comment) {
  const writes = [];
  return { writes, query: async (sql, values = []) => {
    if (sql.includes("FROM issue_pull_request WHERE issue_id")) return { rows: [] };
    if (sql.includes("FROM issue_dependency WHERE issue_id")) return { rows: [] };
    if (sql.includes("FROM comment WHERE issue_id")) return { rows: comment ? [{ content: comment }] : [] };
    if (sql.includes("INSERT INTO github_pull_request")) {
      writes.push({ sql, values });
      return { rows: [{ id: "55555555-5555-4555-8555-555555555555" }] };
    }
    if (sql.includes("INSERT INTO issue_pull_request")) { writes.push({ sql, values }); return { rows: [] }; }
    return { rows: [] };
  }};
}

const PR_VIEW = JSON.stringify({
  number: 412, title: "fix(queue): enforce workspace ownership", state: "OPEN",
  url: "https://github.com/timrecursify/multica/pull/412",
  headRefOid: "852828aec35bccd3fefd67538a222f18b29b9e24", headRefName: "fix/queue-ownership",
  createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z",
  mergedAt: null, closedAt: null, author: { login: "octocat" },
  additions: 12, deletions: 3, changedFiles: 2,
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "SKIPPED" }]
});

test("terminalBlocker derives a ci link from an observed PR comment", async () => {
  const db = commentHarness("opened https://github.com/timrecursify/multica/pull/412 for this");
  const githubCommand = (args) => { assert.equal(args[1], "view"); return PR_VIEW; };
  assert.equal(await terminalBlocker(db, issue, { outcome: "BLOCKED", blocked_on: "ci" }, { githubCommand }), null);

  const pr = db.writes.find((w) => w.sql.includes("INSERT INTO github_pull_request"));
  // Every persisted field comes from the GitHub response; none is synthesised.
  assert.equal(pr.values[0], issue.workspace_id);
  assert.deepEqual(pr.values.slice(1, 8), ["timrecursify", "multica", 412,
    "fix(queue): enforce workspace ownership", "open",
    "https://github.com/timrecursify/multica/pull/412", "fix/queue-ownership"]);
  assert.equal(pr.values[13], "852828aec35bccd3fefd67538a222f18b29b9e24");
  assert.equal(pr.values[19], "SUCCESS");
  const link = db.writes.find((w) => w.sql.includes("INSERT INTO issue_pull_request"));
  assert.deepEqual(link.values, [issue.id, "55555555-5555-4555-8555-555555555555"]);
});

test("terminalBlocker rolls a failing or pending checks rollup up honestly", async () => {
  for (const [checks, expected] of [
    [[{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }], "FAILURE"],
    [[{ conclusion: "SUCCESS" }, { state: "PENDING" }], "PENDING"],
    [[], null]
  ]) {
    const db = commentHarness("https://github.com/timrecursify/multica/pull/412");
    const githubCommand = () => JSON.stringify({ ...JSON.parse(PR_VIEW), statusCheckRollup: checks });
    await terminalBlocker(db, issue, { outcome: "BLOCKED", blocked_on: "ci" }, { githubCommand });
    assert.equal(db.writes.find((w) => w.sql.includes("INSERT INTO github_pull_request")).values[19], expected);
  }
});

test("terminalBlocker never invents evidence it cannot observe", async () => {
  // A dependency blocker is not answered by a PR: it needs a dependency state.
  const dep = commentHarness("https://github.com/timrecursify/multica/pull/412");
  assert.equal(await terminalBlocker(dep, issue, { outcome: "BLOCKED", blocked_on: "dependency" },
    { githubCommand: () => { throw new Error("gh must not run for a dependency blocker"); } }),
    "blocked_dependency_unobservable");
  assert.deepEqual(dep.writes, []);

  // No PR named anywhere: the park stands and gh is never called.
  const none = commentHarness(null);
  assert.equal(await terminalBlocker(none, issue, { outcome: "BLOCKED", blocked_on: "ci" },
    { githubCommand: () => { throw new Error("gh must not run without a PR pointer"); } }),
    "blocked_ci_unobservable");
  assert.deepEqual(none.writes, []);

  // An unreadable PR leaves the ticket parked rather than guessing at its state.
  const broken = commentHarness("https://github.com/timrecursify/multica/pull/412");
  assert.equal(await terminalBlocker(broken, issue, { outcome: "BLOCKED", blocked_on: "sha" },
    { githubCommand: () => { throw new Error("gh: not found"); } }),
    "blocked_sha_unobservable");
  assert.deepEqual(broken.writes, []);
});

test("the task budget counts only tasks since the issue entered its stage", async () => {
  const sql = lifetimeTasksSql();
  assert.match(sql, /relay_run_log/);
  assert.match(sql, /to_stage = \$2/);
  assert.match(sql, /created_at >= GREATEST/);
  // A dispatch writes from_stage = to_stage. Without this the window restarts
  // on every dispatch and the budget can never be reached.
  assert.match(sql, /from_stage IS DISTINCT FROM to_stage/);
  // A Parked or Human Review release opens the window too, matching the
  // bridge's humanReleaseAt: a release followed by a direct Queue -> In
  // Progress hand-off writes no arrival row, so GSP-2351 was counted at 9/6
  // against an arrival that predated the release.
  assert.match(sql, /parked_release_at/);
  assert.match(sql, /human_review_release_at/);
});
