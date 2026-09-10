"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ASTRA_ADJUDICATION_KIND,
  adjudicationContext,
  isAstraAdjudicator,
  parseAstraOutcome,
  recordAstraAdjudication,
  selectAstraAdjudicator,
  trustedAstraAssessment
} = require("./astra-adjudication.cjs");

const instructions = "Human Review adjudication: technical_scope bounded_repair duplicate_noop human_approval";
const astra = { id: "astra-1", name: "ppp-astra-adjudicator-1", model: "gpt-6-astra",
  runtime_id: "runtime-1", instructions, max_concurrent_tasks: 1, active_task_count: 0,
  runtime_config: { model: "gpt-6-astra", role: "human-review-adjudication", astra_adjudication: true } };

test("Astra outcome contract is explicit and bounded", () => {
  const base = { decision_revision: "rev-1", category: "technical", evidence: "task:one" };
  assert.deepEqual(parseAstraOutcome(`ASTRA_ADJUDICATION_JSON=${JSON.stringify({
    ...base, outcome: "technical_scope", next_owner: "spec"
  })}`).outcome, "technical_scope");
  assert.equal(parseAstraOutcome(`ASTRA_ADJUDICATION_JSON=${JSON.stringify({
    ...base, outcome: "technical_scope"
  })}`), null);
  assert.equal(parseAstraOutcome(`ASTRA_ADJUDICATION_JSON=${JSON.stringify({
    ...base, outcome: "human_approval"
  })}`), null);
  assert.equal(parseAstraOutcome("outcome: technical"), null);
});

test("only a dedicated exact-model Astra seat is admitted", () => {
  assert.equal(isAstraAdjudicator(astra), true);
  assert.equal(isAstraAdjudicator({ ...astra, model: "gpt-5.6-sol",
    runtime_config: { ...astra.runtime_config, model: "gpt-5.6-sol" } }), false);
  assert.equal(isAstraAdjudicator({ ...astra,
    runtime_config: { ...astra.runtime_config, astra_adjudication: false } }), false);
  assert.equal(isAstraAdjudicator({ ...astra, instructions: "generic scoper" }), false);
  assert.equal(selectAstraAdjudicator([{ ...astra, active_task_count: 1 }]).reason,
    "astra_adjudication_owner_at_capacity");
  assert.equal(selectAstraAdjudicator([]).reason, "astra_adjudication_owner_absent");
});

test("adjudication task is no_builder and preserves decision revision", () => {
  assert.deepEqual(adjudicationContext({ purpose: "classification", decision: "choose refund",
    decision_revision: "rev-1", suggestion: "money",
    reason: "human_review_classification_required" }), {
    kind: ASTRA_ADJUDICATION_KIND, purpose: "classification", decision: "choose refund",
    decision_revision: "rev-1", suggested_category: "money", no_builder: true,
    reason_code: "human_review_classification_required",
    outcomes: ["technical_scope", "bounded_repair", "duplicate_noop", "human_approval"]
  });
});

test("missing Astra owner records a named hold without a fallback task", async () => {
  const calls = [];
  const client = { query: async (sql, values = []) => {
    calls.push({ sql, values });
    if (/SELECT a\.id/.test(sql)) return { rows: [] };
    return { rows: [], rowCount: 1 };
  } };
  const result = await recordAstraAdjudication(client,
    { id: "issue-1", workspace_id: "workspace-1", priority: "high" }, {
      purpose: "classification", reason: "human_review_classification_required",
      decision: "choose route", decision_revision: "rev-1", suggestion: null
    });
  assert.equal(result.task_id, null);
  assert.equal(result.reason, "astra_adjudication_owner_absent");
  assert.equal(calls.some(({ sql }) => /INSERT INTO agent_task_queue/.test(sql)), false);
  assert.ok(calls.some(({ values }) => values.includes("astra_adjudication_owner_absent")));
});

test("Astra route queues at most one revision-bound no_builder task", async () => {
  const calls = [];
  const client = { query: async (sql, values = []) => {
    calls.push({ sql, values });
    if (/SELECT a\.id/.test(sql)) return { rows: [astra] };
    if (/INSERT INTO agent_task_queue/.test(sql)) return { rows: [{ id: "task-1" }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  } };
  const result = await recordAstraAdjudication(client,
    { id: "issue-1", workspace_id: "workspace-1", priority: "high" }, {
      purpose: "lifetime_exhaustion", reason: "lifetime_task_limit",
      decision: "resolve exhausted task budget", decision_revision: "rev-1",
      attempts: 6, ceiling: 6
    });
  assert.equal(result.task_id, "task-1");
  const insert = calls.find(({ sql }) => /INSERT INTO agent_task_queue/.test(sql));
  assert.match(insert.sql, /existing\.context->>'decision_revision' = \$10/);
  assert.match(insert.values[5], /"no_builder":true/);
  assert.equal(insert.values[9], "rev-1");
});

test("replay reuses the existing revision task even when the owner is now at capacity", async () => {
  const calls = [];
  const client = { query: async (sql) => {
    calls.push(sql);
    if (/SELECT id, status FROM agent_task_queue/.test(sql)) {
      return { rows: [{ id: "task-existing", status: "queued" }], rowCount: 1 };
    }
    if (/SELECT a\.id/.test(sql)) {
      return { rows: [{ ...astra, active_task_count: 1 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  } };
  const result = await recordAstraAdjudication(client,
    { id: "issue-1", workspace_id: "workspace-1", priority: "high" }, {
      purpose: "lifetime_exhaustion", reason: "lifetime_task_limit",
      decision: "resolve exhausted task budget", decision_revision: "rev-1",
      attempts: 6, ceiling: 6
    });
  assert.equal(result.task_id, "task-existing");
  assert.equal(result.reused, true);
  assert.equal(calls.some((sql) => /SELECT a\.id/.test(sql)), false);
  assert.equal(calls.some((sql) => /INSERT INTO agent_task_queue/.test(sql)), false);
});

test("an invalid completed adjudication stays held without spawning replay tasks", async () => {
  const calls = [];
  const client = { query: async (sql, values = []) => {
    calls.push({ sql, values });
    if (/SELECT id, status FROM agent_task_queue/.test(sql)) {
      return { rows: [{ id: "task-invalid", status: "completed" }] };
    }
    return { rows: [], rowCount: 1 };
  } };
  const result = await recordAstraAdjudication(client,
    { id: "issue-1", workspace_id: "workspace-1", priority: "high" }, {
      purpose: "classification", reason: "human_review_classification_required",
      decision: "choose route", decision_revision: "rev-1"
    });
  assert.equal(result.task_id, "task-invalid");
  assert.equal(result.reason, "astra_adjudication_outcome_invalid");
  assert.equal(calls.some(({ sql }) => /INSERT INTO agent_task_queue/.test(sql)), false);
  assert.ok(calls.some(({ values }) => values.includes("astra_adjudication_outcome_invalid")));
});

test("trusted assessment validates task revision, output, model, and configured role", async () => {
  const output = `ASTRA_ADJUDICATION_JSON=${JSON.stringify({
    decision_revision: "rev-1", outcome: "technical_scope", category: "technical",
    next_owner: "spec", evidence: "activity:one"
  })}`;
  const client = { query: async () => ({ rows: [{ ...astra, id: "task-1", agent_id: "astra-1",
    completed_at: "2026-09-10T00:00:00Z", result: { output } }] }) };
  const assessment = await trustedAstraAssessment(client, { id: "issue-1" }, "rev-1", "classification");
  assert.equal(assessment.trusted, true);
  assert.equal(assessment.category, "technical");
  assert.equal(assessment.assessor_task_id, "task-1");
  const stale = { query: async () => ({ rows: [{ ...astra, id: "task-1", agent_id: "astra-1",
    result: { output: output.replaceAll("rev-1", "old-rev") } }] }) };
  assert.equal(await trustedAstraAssessment(stale, { id: "issue-1" }, "rev-1", "classification"), null);
});
