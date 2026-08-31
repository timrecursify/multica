const assert = require('node:assert/strict');
const test = require('node:test');
const { Client } = require('pg');

Object.assign(process.env, { JWT_SECRET: process.env.JWT_SECRET || 'test-jwt', DATABASE_URL: process.env.DATABASE_URL || 'postgres://test', RELAY_AGENT_SECRET: process.env.RELAY_AGENT_SECRET || 'relay-secret', MULTICA_WORKSPACE_ID: process.env.MULTICA_WORKSPACE_ID || 'workspace' });
const { relayAdvance } = require('./multica-bridge.cjs');
const makeResponse = () => ({ writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } });

test('QC FAIL return authenticates its active task and dispatches one builder', async () => {
  const saved = { query: Client.prototype.query, connect: Client.prototype.connect, end: Client.prototype.end };
  const calls = [];
  Client.prototype.connect = async () => {};
  Client.prototype.end = async () => {};
  Client.prototype.query = async function(sql, values) {
    calls.push({ sql, values });
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT stage_name')) return { rows: [{ stage_name: 'In Progress' }] };
    if (sql.includes('FROM "issue"')) return { rows: [{ id: 'issue', status: 'In Review', workspace_id: 'workspace', priority: 'high' }] };
    if (sql.includes('SELECT next_stage')) return { rows: [{ next_stage: 'In Progress', alt_next_stages: [] }] };
    if (sql.includes('FROM task_token t')) return { rows: [{ id: 'qc-task', agent_id: 'qc-agent' }] };
    if (sql.includes('FROM qc_verdict')) return { rows: [{ verdict: 'FAIL', work_product_md5: 'work' }] };
    if (sql.includes('SELECT rsc.agent_id')) return { rows: [{ agent_id: 'builder-agent', agent_name: 'builder', instructions: 'Own Queue and In Progress build stages', selected_runtime_id: 'runtime', selected_runtime_provider: 'codex' }] };
    if (sql.includes("SELECT agent_id FROM relay_stage_config WHERE stage_name = 'In Review'")) return { rows: [{ agent_id: 'qc-agent' }] };
    if (sql.includes('UPDATE "issue"')) return { rows: [{ id: 'issue', status: 'In Progress' }], rowCount: 1 };
    if (sql.includes('INSERT INTO agent_task_queue')) return { rows: [{ id: 'builder-task' }], rowCount: 1 };
    if (sql.includes('INSERT INTO relay_run_log')) return { rows: [{ id: 'log' }], rowCount: 1 };
    if (sql.includes("SET status = 'completed'")) return { rows: [], rowCount: 1 };
    if (sql.includes("context->>'to_stage'") || sql.includes('WHERE issue_id = $1 AND started_at IS NOT NULL')) return { rows: [{ n: 0 }] };
    throw new Error(`unexpected SQL: ${sql}`);
  };
  try {
    const res = makeResponse();
    await relayAdvance({}, res, { issue_id: 'issue', to_stage: 'In Progress', agent_task_token: 'mat_task', current_work_product_md5: 'work' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.task_id, 'builder-task');
    assert.equal(calls.find(c => c.sql.includes('INSERT INTO agent_task_queue')).values[0], 'builder-agent');
    assert.ok(calls.some(c => c.sql.includes("SET status = 'completed'") && c.values[0] === 'qc-task'));
  } finally { Object.assign(Client.prototype, saved); }
});

test('shared relay secret alone cannot return QC work', async () => {
  const saved = { query: Client.prototype.query, connect: Client.prototype.connect, end: Client.prototype.end };
  Client.prototype.connect = async () => {};
  Client.prototype.end = async () => {};
  Client.prototype.query = async function(sql) {
    if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('SELECT stage_name')) return { rows: [{ stage_name: 'In Progress' }] };
    if (sql.includes('FROM "issue"')) return { rows: [{ id: 'issue', status: 'In Review', workspace_id: 'workspace' }] };
    if (sql.includes('SELECT next_stage')) return { rows: [{ next_stage: 'In Progress', alt_next_stages: [] }] };
    throw new Error(`unexpected SQL: ${sql}`);
  };
  try {
    const res = makeResponse();
    await relayAdvance({}, res, { issue_id: 'issue', to_stage: 'In Progress', agent_token: 'relay-secret' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'qc_task_auth_required');
  } finally { Object.assign(Client.prototype, saved); }
});
