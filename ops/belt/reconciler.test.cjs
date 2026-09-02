"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { reconcileIssue, taskContext, issueCandidatesSql, liveTasksSql } = require("./reconciler.cjs");

const issue = { id: "11111111-1111-4111-8111-111111111111", workspace_id: "22222222-2222-4222-8222-222222222222", status: "Queue", priority: "none" };
const ok = () => ({ ok: true });

function harness({ live = [], owner = { agent_id: "33333333-3333-4333-8333-333333333333" } } = {}) {
  const calls = []; let inserted = 0;
  return { calls, query: async (sql, values = []) => {
    calls.push({ sql, values });
    if (sql.startsWith("SELECT id, workspace_id, status")) return { rows: [issue] };
    if (sql.includes("FROM agent_task_queue") && sql.includes("FOR UPDATE")) return { rows: live };
    if (sql.includes("FROM relay_stage_agent_pool")) return { rows: owner ? [owner] : [] };
    if (sql.includes("INSERT INTO agent_task_queue")) return { rows: [{ id: `task-${++inserted}` }] };
    return { rows: [] };
  }};
}

test("query builders hold the live status invariant", () => {
  assert.match(issueCandidatesSql(), /status = ANY/);
  assert.match(liveTasksSql(), /FOR UPDATE/);
  assert.deepEqual(taskContext("Queue"), { source: "reconcile", kind: "stage_task", to_stage: "Queue" });
});

test("zero-task issue creates exactly one reconcile task and pending log", async () => {
  const db = harness();
  const result = await reconcileIssue(db, issue.id, { evaluate: ok });
  assert.deepEqual(result, { action: "created", taskId: "task-1" });
  const insert = db.calls.find((call) => call.sql.includes("INSERT INTO agent_task_queue"));
  assert.equal(JSON.parse(insert.values[4]).source, "reconcile");
  assert.ok(db.calls.some((call) => call.sql.includes("INSERT INTO relay_run_log")));
});

test("restart is idempotent when the current-stage task is live", async () => {
  const db = harness({ live: [{ id: "task-live", status: "queued", context: taskContext("Queue") }] });
  assert.deepEqual(await reconcileIssue(db, issue.id, { evaluate: ok }), { action: "already_live", taskId: "task-live" });
  assert.equal(db.calls.some((call) => call.sql.includes("INSERT INTO agent_task_queue")), false);
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
      if (sql.startsWith("SELECT id, workspace_id, status")) return { rows: [issue] };
      if (sql.includes("FROM agent_task_queue") && sql.includes("FOR UPDATE")) return { rows: shared.live };
      if (sql.includes("FROM relay_stage_agent_pool")) return { rows: [{ agent_id: "33333333-3333-4333-8333-333333333333" }] };
      if (sql.includes("INSERT INTO agent_task_queue")) {
        const row = { id: `task-${++shared.sequence}`, status: "queued", context: JSON.parse(values[4]) };
        shared.live.push(row); return { rows: [row] };
      }
      return { rows: [] };
    }};
  };
  const results = await Promise.all([reconcileIssue(session(), issue.id, { evaluate: ok }), reconcileIssue(session(), issue.id, { evaluate: ok })]);
  assert.deepEqual(results.map((result) => result.action), ["created", "already_live"]);
  assert.equal(shared.live.length, 1);
});

test("duplicate live task fails closed into Human Review", async () => {
  const db = harness({ live: ["a", "b"].map((id) => ({ id, status: "queued", context: taskContext("Queue") })) });
  assert.deepEqual(await reconcileIssue(db, issue.id, { evaluate: ok }), { action: "human_review", reason: "duplicate_live_task" });
  assert.ok(db.calls.some((call) => call.sql.includes("UPDATE issue SET status = 'Human Review'")));
});

test("missing owner and exhausted retry move the issue atomically to Human Review", async () => {
  const missing = harness({ owner: null });
  assert.equal((await reconcileIssue(missing, issue.id, { evaluate: ok })).reason, "unresolved_owner");
  const exhausted = harness();
  assert.equal((await reconcileIssue(exhausted, issue.id, { evaluate: ok, isRetryExhausted: () => true })).reason, "retry_exhausted");
  assert.equal(exhausted.calls.some((call) => call.sql.includes("INSERT INTO agent_task_queue")), false);
});
