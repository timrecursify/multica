"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const stageOutcome = require("./stage-outcome.cjs");

const beltRoot = __dirname;
const read = (relativePath) => fs.readFileSync(path.join(beltRoot, relativePath), "utf8");

test("work-product schema keeps one explicit active product per issue and scope", () => {
  const table = read("sql/2026-09-07_01_issue_work_product.up.sql");
  assert.match(table, /CREATE TABLE IF NOT EXISTS issue_work_product/);
  for (const column of ["issue_id", "scope_revision", "kind", "repository", "branch",
    "pr_number", "head_sha", "acceptance_evidence", "replaces_scope_revision",
    "consuming_stage", "dependency_issue_ids", "status"]) {
    assert.match(table, new RegExp(`\\b${column}\\b`));
  }
  assert.doesNotMatch(table, /FOREIGN KEY|REFERENCES|CASCADE/i);

  for (const name of ["02_issue_work_product_identity", "03_issue_work_product_active"]) {
    const up = read(`sql/2026-09-07_${name}.up.sql`);
    const down = read(`sql/2026-09-07_${name}.down.sql`);
    assert.match(up, /^CREATE UNIQUE INDEX CONCURRENTLY/);
    assert.equal((up.match(/;/g) || []).length, 1);
    assert.match(down, /^DROP INDEX CONCURRENTLY IF EXISTS/);
    assert.equal((down.match(/;/g) || []).length, 1);
  }
  assert.match(read("sql/2026-09-07_01_issue_work_product.down.sql"),
    /^DROP TABLE IF EXISTS issue_work_product;/);
});

test("stage identity is the active product and its declared dependencies, never prose", () => {
  const sql = stageOutcome.stageInputHashSql();
  assert.match(sql, /FROM issue_work_product/);
  assert.match(sql, /status = 'active'/);
  assert.match(sql, /dependency_issue_ids/);
  assert.doesNotMatch(sql, /FROM comment|issue_pull_request/);
});

test("an implementation handoff requires freshly produced evidence, not only a pre-existing row", async () => {
  const writes = [];
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push(sql);
      if (sql.includes("FROM agent_task_queue")) return { rows: [
        { id: "task-1", issue_id: "issue-1", stage: "In Progress", output: "OUTCOME: ADVANCED" },
      ] };
      if (sql.includes("AS has_review_evidence")) return { rows: [{ has_review_evidence: true }] };
      if (sql.includes("AS input_hash")) return { rows: [{ input_hash: "product-hash" }] };
      if (sql.includes("INSERT INTO issue_stage_outcome")) writes.push(params);
      return { rows: [] };
    },
  };

  const result = await stageOutcome.recordStageOutcomes(client, { logger: { log: () => {} } });
  assert.deepEqual(result, { scanned: 1, recorded: 1, failed: 0 });
  assert.equal(writes[0][2], "FAILED");
  const evidenceRead = queries.find((sql) => sql.includes("AS has_review_evidence"));
  assert.match(evidenceRead, /FROM issue_work_product/);
  assert.match(evidenceRead, /status = 'active'/);
  assert.match(evidenceRead, /consuming_stage = 'In Review'/);
  assert.doesNotMatch(evidenceRead, /FROM comment|issue_pull_request/);
});

test("CI/CD consumes one declared PR and does not rediscover PRs in comments", () => {
  const worker = read("multica-cicd-worker.cjs");
  assert.match(worker, /FROM issue_work_product/);
  assert.doesNotMatch(worker, /SELECT content FROM comment/);
  assert.doesNotMatch(worker, /open PRs \(.*keep exactly one/);
});

test("worker doctrine reuses the canonical PR and records evidence without fake diffs", () => {
  const runbook = read("RUNBOOK_BUILD_WORKER.md");
  const common = read("WORKER_COMMON.md");
  assert.match(runbook, /reuse the active work product's branch and\s+pull\s+request/i);
  assert.match(runbook, /never open a second pull request/i);
  assert.match(runbook, /never manufacture a\s+test edit/i);
  assert.match(common, /consumer owns merge, rebase, and disposition/i);
  assert.match(common, /acceptance evidence/i);
});

test("build outcome atomically inserts ownership and rework updates its exact identity against PostgreSQL", async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for the real PostgreSQL regression test");
  const { Client } = require("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  const schema = `work_product_${process.pid}_${Date.now()}`;
  const issueId = "11111111-1111-4111-8111-111111111111";
  const prId = "22222222-2222-4222-8222-222222222222";
  const task1 = "33333333-3333-4333-8333-333333333333";
  const task2 = "44444444-4444-4444-8444-444444444444";
  const task3 = "66666666-6666-4666-8666-666666666666";
  const sha1 = "a".repeat(40); const sha2 = "b".repeat(40); const sha3 = "c".repeat(40);
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query("CREATE TABLE issue (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, status text NOT NULL)");
    await client.query("CREATE TABLE agent_task_queue (id uuid PRIMARY KEY, issue_id uuid, status text, context jsonb, result jsonb, created_at timestamptz, completed_at timestamptz)");
    await client.query("CREATE TABLE relay_run_log (issue_id uuid, from_stage text, to_stage text, task_id uuid, created_at timestamptz)");
    await client.query("CREATE TABLE github_pull_request (id uuid PRIMARY KEY, workspace_id uuid, repo_owner text, repo_name text, pr_number int, branch text, html_url text, head_sha text, checks_rollup_state text, updated_at timestamptz)");
    await client.query("CREATE TABLE issue_pull_request (issue_id uuid, pull_request_id uuid)");
    await client.query("CREATE TABLE github_pull_request_check_suite (pr_id uuid, suite_id bigint, status text, conclusion text, head_sha text)");
    await client.query("CREATE TABLE issue_stage_outcome (issue_id uuid, stage text, outcome text, blocked_on text, task_id uuid, input_hash text, outcome_at timestamptz, UNIQUE(issue_id, stage))");
    await client.query(read("sql/2026-09-07_01_issue_work_product.up.sql"));
    await client.query("CREATE UNIQUE INDEX issue_work_product_identity_test_idx ON issue_work_product (issue_id, scope_revision)");
    await client.query("CREATE UNIQUE INDEX issue_work_product_active_test_idx ON issue_work_product (issue_id) WHERE status = 'active'");
    await client.query("INSERT INTO issue VALUES ($1, $2, 'In Progress')", [issueId, "55555555-5555-4555-8555-555555555555"]);
    await client.query("INSERT INTO github_pull_request VALUES ($1,$2,'acme','widget',7,'fix/belt','https://github.com/acme/widget/pull/7',$3,NULL,NOW())", [prId, "55555555-5555-4555-8555-555555555555", sha1]);
    await client.query("INSERT INTO issue_pull_request VALUES ($1,$2)", [issueId, prId]);
    const insertTask = async (id, sha) => {
      await client.query(
        "INSERT INTO agent_task_queue VALUES ($1,$2,'completed',$3::jsonb,$4::jsonb,NOW(),NOW())",
        [id, issueId, JSON.stringify({ from_stage: "In Progress", to_stage: "In Review" }), JSON.stringify({ output: `PR https://github.com/acme/widget/pull/7 head ${sha}\nOUTCOME: ADVANCED` })]);
      await client.query(
        "INSERT INTO relay_run_log (issue_id, from_stage, to_stage, task_id, created_at) VALUES ($1,'In Progress','In Review',$2,NOW())",
        [issueId, id]);
    };
    let observedSha = sha1;
    const githubCommand = async (_args, options) => {
      assert.equal(options.fresh, true);
      return JSON.stringify({ number: 7, url: "https://github.com/acme/widget/pull/7", headRefName: "fix/belt", headRefOid: observedSha });
    };
    await insertTask(task1, sha1);
    assert.deepEqual(await stageOutcome.recordStageOutcomes(client, { githubCommand, logger: { log() {} } }), { scanned: 1, recorded: 1, failed: 0 });
    const first = (await client.query("SELECT * FROM issue_work_product WHERE issue_id=$1", [issueId])).rows[0];
    assert.equal(first.repository, "acme/widget"); assert.equal(first.branch, "fix/belt");
    assert.equal(first.pr_number, 7); assert.equal(first.head_sha, sha1);
    await client.query("UPDATE github_pull_request SET head_sha=$2, updated_at=NOW() WHERE id=$1", [prId, sha2]);
    observedSha = sha2; await insertTask(task2, sha2);
    assert.deepEqual(await stageOutcome.recordStageOutcomes(client, { githubCommand, logger: { log() {} } }), { scanned: 1, recorded: 1, failed: 0 });
    const products = (await client.query("SELECT * FROM issue_work_product WHERE issue_id=$1", [issueId])).rows;
    assert.equal(products.length, 1); assert.equal(products[0].scope_revision, first.scope_revision);
    assert.equal(products[0].head_sha, sha2); assert.equal(products[0].created_at.toISOString(), first.created_at.toISOString());
    const outcome = (await client.query("SELECT outcome, task_id FROM issue_stage_outcome WHERE issue_id=$1", [issueId])).rows[0];
    assert.deepEqual(outcome, { outcome: "ADVANCED", task_id: task2 });
    await client.query(`ALTER TABLE issue_stage_outcome ADD CONSTRAINT reject_third_task
      CHECK (task_id <> '${task3}'::uuid)`);
    await client.query("UPDATE github_pull_request SET head_sha=$2, updated_at=NOW() WHERE id=$1", [prId, sha3]);
    observedSha = sha3; await insertTask(task3, sha3);
    assert.deepEqual(await stageOutcome.recordStageOutcomes(client, { githubCommand, logger: { log() {} } }), { scanned: 1, recorded: 0, failed: 1 });
    const rolledBack = (await client.query("SELECT head_sha FROM issue_work_product WHERE issue_id=$1", [issueId])).rows[0];
    assert.equal(rolledBack.head_sha, sha2, "outcome failure must roll back the work-product update");
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  }
});
