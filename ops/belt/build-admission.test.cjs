const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTaskAdmission } = require("./build-admission.cjs");

function db({ prior, failure, unreviewedFailure, successor } = {}) {
  return { calls: [], async query(sql, values) {
    this.calls.push({ sql, values });
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("SELECT task.id")) return { rows: prior ? [prior] : [] };
    if (sql.includes("SELECT id FROM qc_effective_verdict")) return { rows: failure ? [failure] : [] };
    if (sql.includes("SELECT outcome.task_id")) return { rows: unreviewedFailure ? [unreviewedFailure] : [] };
    if (sql.includes("retry_of_task_id")) return { rows: successor ? [successor] : [] };
    throw new Error(`unexpected SQL: ${sql}`);
  }};
}

test("first build is admitted", async () => {
  assert.deepEqual(await buildTaskAdmission(db(), { issueId: "issue", toStage: "Queue" }), { admit: true });
});

test("GSP-2406 replay reuses completed PR-bearing build", async () => {
  const client = db({ prior: { id: "1429d9c4", completed_at: "2026-09-07T00:00:00Z" } });
  assert.deepEqual(await buildTaskAdmission(client, { issueId: "gsp-2406", toStage: "In Progress" }),
    { admit: false, reuseTaskId: "1429d9c4", reason: "completed_build_work_product" });
});

test("completed build products are correlated to the requested stage", async () => {
  const client = db({ prior: { id: "current-stage-task", completed_at: "2026-09-07T00:00:00Z" } });
  await buildTaskAdmission(client, { issueId: "stage-owner", toStage: "In Progress" });
  const priorQuery = client.calls.find(({ sql }) => sql.includes("SELECT task.id"));
  assert.match(priorQuery.sql, /task\.context->>'to_stage'=\$2::text/);
  assert.deepEqual(priorQuery.values, ["stage-owner", "In Progress"]);
});

test("GSP-2403 qualifying implementation failure admits exactly one linked retry", async () => {
  const prior = { id: "7f3916a4", completed_at: "2026-09-07T00:00:00Z" };
  const first = await buildTaskAdmission(db({ prior, failure: { id: 1772 } }),
    { issueId: "gsp-2403", toStage: "In Progress" });
  assert.deepEqual(first, { admit: true, retryOfTaskId: "7f3916a4", qcAttemptId: "1772" });
  const replay = await buildTaskAdmission(db({ prior, failure: { id: 1772 }, successor: { id: "b4277af2" } }),
    { issueId: "gsp-2403", toStage: "In Progress" });
  assert.deepEqual(replay, { admit: false, reuseTaskId: "b4277af2", reason: "implementation_retry_exists" });
  assert.equal(replay.admit, false, "the effective failure event admits only one corrective task");
});

test("correlated FAILED build without any QC verdict admits a retry", async () => {
  const prior = { id: "failed-build", completed_at: "2026-09-07T00:00:00Z" };
  assert.deepEqual(await buildTaskAdmission(db({ prior, unreviewedFailure: { task_id: prior.id } }),
    { issueId: "stranded", toStage: "In Progress" }),
  { admit: true, retryOfTaskId: prior.id });
});

test("historical QC verdict does not suppress a current correlated FAILED retry", async () => {
  const prior = { id: "failed-build", completed_at: "2026-09-07T00:00:00Z" };
  const client = db({ prior, unreviewedFailure: { task_id: prior.id } });
  assert.deepEqual(await buildTaskAdmission(client, { issueId: "stranded", toStage: "In Progress" }),
    { admit: true, retryOfTaskId: prior.id });
  const admissionSql = client.calls.find(({ sql }) => sql.includes("SELECT outcome.task_id")).sql;
  assert.doesNotMatch(admissionSql, /NOT EXISTS[\s\S]*qc_effective_verdict/);
});

test("non-build stages bypass admission", async () => {
  const client = db();
  assert.deepEqual(await buildTaskAdmission(client, { issueId: "issue", toStage: "In Review" }), { admit: true });
  assert.equal(client.calls.length, 0);
});
