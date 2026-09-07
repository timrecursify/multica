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

test("an implementation handoff requires a consumable active work product", async () => {
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
  assert.equal(writes[0][2], "ADVANCED");
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
