#!/usr/bin/env node
"use strict";

const { Pool } = require("pg");
const {
  produceImplementationWorkProduct,
} = require("./stage-outcome.cjs");
const {
  reconcileGithubCommand,
} = require("./parity/multica-relay-advance-daemon.cjs");

function parseArgs(argv) {
  const options = { apply: false };
  for (const arg of argv) {
    if (arg === "--apply") options.apply = true;
    else if (arg === "--dry-run") options.apply = false;
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

function candidatesSql() {
  return `SELECT i.id AS issue_id, i.number AS issue_number,
                 w.name AS workspace, w.slug AS workspace_slug,
                 task.id, task.output, task.scope_revision
            FROM issue i
            JOIN workspace w ON w.id = i.workspace_id
            LEFT JOIN LATERAL (
              SELECT t.id, t.result->>'output' AS output,
                     CASE WHEN (t.context->>'scope_revision') ~ '^[1-9][0-9]*$'
                       THEN (t.context->>'scope_revision')::bigint
                       ELSE floor(extract(epoch FROM t.created_at) * 1000000)::bigint
                     END AS scope_revision
                FROM agent_task_queue t
               WHERE t.issue_id = i.id AND t.status = 'completed'
                 AND t.context->>'to_stage' = 'In Progress'
               ORDER BY t.completed_at DESC NULLS LAST, t.created_at DESC, t.id DESC
               LIMIT 1
            ) task ON true
           WHERE i.status = 'In Progress'
             AND NOT EXISTS (
               SELECT 1 FROM issue_work_product wp
                WHERE wp.issue_id = i.id AND wp.status = 'active'
             )
           ORDER BY w.slug, i.number`;
}

async function linkedPullRequests(client, issueId) {
  return (await client.query(
    `SELECT DISTINCT p.repo_owner || '/' || p.repo_name AS repository,
            p.pr_number, p.branch, p.html_url
       FROM issue_pull_request ipr
       JOIN github_pull_request p ON p.id = ipr.pull_request_id
       JOIN issue i ON i.id = ipr.issue_id AND i.workspace_id = p.workspace_id
      WHERE ipr.issue_id = $1::uuid
      ORDER BY repository, p.pr_number`, [issueId])).rows;
}

function classifyFailure(trace, allLinked) {
  if (!trace.linked) {
    if (allLinked.length === 0) return "no linked PR";
    return "identity mismatch";
  }
  if (trace.linked.length === 0) {
    if (allLinked.length === 0) return "no linked PR";
    const selected = trace.selectedRepository && trace.selectedPrNumber
      ? `${trace.selectedRepository}#${trace.selectedPrNumber}` : "task output PR";
    const durable = allLinked.map((row) => `${row.repository}#${row.pr_number}`).join(", ");
    return `identity mismatch: producer selected ${selected}; durable link is ${durable}`;
  }
  if (trace.linked.length > 1) return "more than one linked PR";
  if (trace.githubError) return `GitHub read failed: ${trace.githubError}`;
  const candidate = trace.linked[0];
  const view = trace.githubView;
  if (!view || Number(view.number) !== Number(candidate.pr_number) ||
      String(view.url || "").toLowerCase() !== String(candidate.html_url || "").toLowerCase()) {
    return "identity mismatch";
  }
  if (!/^[0-9a-f]{40}$/.test(String(view.headRefOid || "").toLowerCase())) {
    return "sha not 40-hex";
  }
  if (!view.headRefName || (candidate.branch && candidate.branch !== view.headRefName)) {
    return "branch mismatch";
  }
  return "producer rejected candidate";
}

function tracingClient(client, trace) {
  return {
    query: async (sql, params) => {
      const result = await client.query(sql, params);
      if (sql.includes("FROM issue_pull_request")) {
        trace.linked = result.rows;
        trace.selectedRepository = params[1];
        trace.selectedPrNumber = params[2];
      }
      return result;
    },
  };
}

function tracingGithub(trace) {
  return async (args, options) => {
    try {
      const raw = await reconcileGithubCommand(args, options);
      trace.githubView = JSON.parse(raw);
      return raw;
    } catch (error) {
      trace.githubError = error?.message || String(error);
      throw error;
    }
  };
}

async function deriveOne(client, row, { apply }) {
  if (!row.id) return { ...row, succeeded: false, reason: "no latest completed build task" };
  const trace = {};
  await client.query("BEGIN");
  try {
    const current = (await client.query(
      `SELECT i.status,
              EXISTS (SELECT 1 FROM issue_work_product wp
                       WHERE wp.issue_id = i.id AND wp.status = 'active') AS has_active
         FROM issue i WHERE i.id = $1::uuid FOR UPDATE`, [row.issue_id])).rows[0];
    if (!current || current.status !== "In Progress" || current.has_active) {
      await client.query("ROLLBACK");
      return { ...row, succeeded: false, reason: "candidate changed before derivation" };
    }
    const succeeded = await produceImplementationWorkProduct(
      tracingClient(client, trace), row, tracingGithub(trace));
    if (!succeeded) {
      const allLinked = await linkedPullRequests(client, row.issue_id);
      const reason = classifyFailure(trace, allLinked);
      await client.query("ROLLBACK");
      return { ...row, succeeded: false, reason };
    }
    const product = (await client.query(
      `SELECT repository, branch, pr_number, head_sha
         FROM issue_work_product
        WHERE issue_id = $1::uuid AND status = 'active'`, [row.issue_id])).rows[0];
    await client.query(apply ? "COMMIT" : "ROLLBACK");
    return { ...row, succeeded: true, ...product };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return { ...row, succeeded: false, reason: `derivation error: ${error?.message || error}` };
  }
}

async function run(pool, options) {
  const candidates = (await pool.query(candidatesSql())).rows;
  const results = [];
  for (const row of candidates) {
    const client = await pool.connect();
    try { results.push(await deriveOne(client, row, options)); }
    finally { client.release(); }
  }
  const workProductCount = Number((await pool.query(
    "SELECT count(*)::int AS count FROM issue_work_product")).rows[0].count);
  return { mode: options.apply ? "apply" : "dry-run", candidates: candidates.length,
    would_succeed: results.filter((row) => row.succeeded).length,
    would_fail: results.filter((row) => !row.succeeded).length,
    issue_work_product_count: workProductCount, results };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1,
    application_name: "belt-work-product-backfill" });
  try { console.log(JSON.stringify(await run(pool, options), null, 2)); }
  finally { await pool.end(); }
}

if (require.main === module) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { parseArgs, candidatesSql, classifyFailure, deriveOne, run };
