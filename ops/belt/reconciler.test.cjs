"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { reconcileIssue, reconcileCycle, taskContext, issueCandidatesSql, liveTasksSql, ownerSql, stageAttemptsSql,
  moveToHumanReview, terminalBlocker } = require("./reconciler.cjs");

const issue = { id: "11111111-1111-4111-8111-111111111111", workspace_id: "22222222-2222-4222-8222-222222222222", status: "Queue", priority: "none" };
const ok = () => ({ ok: true });

function harness({ live = [], owner = {
  agent_id: "33333333-3333-4333-8333-333333333333",
  selected_runtime_id: "44444444-4444-4444-8444-444444444444"
} } = {}) {
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
  assert.match(issueCandidatesSql(), /parent_issue_id IS NULL/);
  assert.match(liveTasksSql(), /FOR UPDATE/);
  assert.match(ownerSql(), /COALESCE\(own_runtime.id, online_runtime.id\) AS selected_runtime_id/);
  assert.match(ownerSql(), /a.archived_at IS NULL/);
  assert.match(ownerSql(), /a.status IN \('idle', 'working'\)/);
  assert.match(ownerSql(), /COALESCE\(own_runtime.id, online_runtime.id\) IS NOT NULL/);
  assert.match(stageAttemptsSql(), /\$3::int/);
  assert.deepEqual(taskContext("Queue"), { source: "reconcile", kind: "stage_task", to_stage: "Queue" });
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

test("restart is idempotent when the current-stage task is live", async () => {
  const db = harness({ live: [{ id: "task-live", status: "queued", context: taskContext("Queue") }] });
  assert.deepEqual(await reconcileIssue(db, issue.id, { evaluate: ok }), { action: "already_live", taskId: "task-live" });
  assert.equal(db.calls.some((call) => call.sql.includes("INSERT INTO agent_task_queue")), false);
});

test("bundled children and running old-stage tasks are skipped", async () => {
  const child = harness();
  child.query = async (sql, values = []) => {
    if (sql.startsWith("SELECT id, workspace_id, status")) return { rows: [{ ...issue, parent_issue_id: "parent" }] };
    return { rows: [] };
  };
  assert.deepEqual(await reconcileIssue(child, issue.id, { evaluate: ok }), { action: "skipped" });
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
  db.query = async (sql, values) => sql.startsWith("SELECT id, workspace_id, status, priority, metadata, qc_fail_count\n            FROM issue WHERE")
    ? { rows: [issue] } : original(sql, values);
  assert.deepEqual(await reconcileCycle(db, { evaluate: ok }), [{ action: "created", taskId: "task-1" }]);
});

test("cycle rolls back a throwing issue and reconciles the next issue", async () => {
  const second = { ...issue, id: "77777777-7777-4777-8777-777777777777" };
  const db = harness();
  const original = db.query;
  db.query = async (sql, values = []) => {
    if (sql.startsWith("SELECT id, workspace_id, status, priority, metadata, qc_fail_count\n            FROM issue WHERE")) {
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

test("per-stage attempt ceiling grows to admit a new task", async () => {
  const db = harness();
  const original = db.query;
  db.query = async (sql, values) => sql.includes("max(attempt)")
    ? { rows: [{ attempt: 2, max_attempts: 2 }] } : original(sql, values);
  assert.deepEqual(await reconcileIssue(db, issue.id, { evaluate: ok }), { action: "created", taskId: "task-1" });
  const insert = db.calls.find((call) => call.sql.includes("INSERT INTO agent_task_queue"));
  assert.equal(insert.values[7], 3);
  assert.equal(insert.values[8], 3);
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
test("terminalBlocker routes only unobservable blockers", async () => {
  const unlinked = { query: async () => ({ rows: [] }) };
  const linked = { query: async () => ({ rows: [{ "?column?": 1 }] }) };
  const b = (outcome, blocked_on) => ({ outcome, blocked_on });

  assert.equal(await terminalBlocker(unlinked, issue, b("BLOCKED", "human")), "blocked_human");
  assert.equal(await terminalBlocker(linked, issue, b("BLOCKED", "human")), "blocked_human");
  assert.equal(await terminalBlocker(unlinked, issue, b("BLOCKED", "ci")), "blocked_ci_unobservable");
  assert.equal(await terminalBlocker(unlinked, issue, b("BLOCKED", "sha")), "blocked_sha_unobservable");
  assert.equal(await terminalBlocker(unlinked, issue, b("BLOCKED", "dependency")), "blocked_dependency_unobservable");
  // A linked PR or dependency still supplies a hash term, so the belt keeps it.
  assert.equal(await terminalBlocker(linked, issue, b("BLOCKED", "ci")), null);
  assert.equal(await terminalBlocker(linked, issue, b("BLOCKED", "dependency")), null);
  // quota clears itself; non-BLOCKED outcomes are not this function's business.
  assert.equal(await terminalBlocker(unlinked, issue, b("BLOCKED", "quota")), null);
  assert.equal(await terminalBlocker(unlinked, issue, b("FAILED", null)), null);
  assert.equal(await terminalBlocker(unlinked, issue, null), null);
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
