const assert = require('node:assert/strict');
const test = require('node:test');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test';
process.env.RELAY_AGENT_SECRET = process.env.RELAY_AGENT_SECRET || 'test';
process.env.MULTICA_WORKSPACE_ID = process.env.MULTICA_WORKSPACE_ID || 'test';
const { parseArgs, recover } = require('./recover-in-review-qc.cjs');
test('requires exact UUID operator scope', () => {
  const id = '123e4567-e89b-12d3-a456-426614174000';
  assert.deepEqual(parseArgs(['--apply', '--issue', id, '--issue', id]).issueIds, [id, id]);
  assert.throws(() => parseArgs(['--apply', '--issue', 'bad']), /UUID/);
  assert.throws(() => parseArgs(['--issue', id]), /--apply/);
});
test('recovery admits the observed #1009/#23696 failed-orphan shape only', () => {
  const source = require('node:fs').readFileSync(require.resolve('./recover-in-review-qc.cjs'), 'utf8');
  assert.match(source, /i\.status = 'In Review'/);
  assert.match(source, /task_usage u WHERE u\.task_id = wrong\.id/);
  assert.doesNotMatch(source, /task_usage u WHERE u\.issue_id = i\.id/);
  assert.match(source, /wrong\.status = 'failed' AND wrong\.started_at IS NULL/);
  assert.match(source, /wrong\.failure_reason = 'operator_orphan_repair'/);
  assert.match(source, /live\.status IN/);
  assert.match(source, /selectOwner\(client, row\.workspace_id, 'In Progress', 'In Review'\)/);
  assert.match(source, /replaceStageTask/);
});

test('recover executes the bounded DB-shaped predicate then creates one QC successor', async () => {
  const calls = []; const owners = []; const replacements = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: [{ id: values[0], workspace_id: 'workspace-1', priority: 'high' }] };
  } };
  const id = '123e4567-e89b-12d3-a456-426614174000';
  const task = await recover(client, id, {
    selectStageOwner: async (...args) => { owners.push(args); return { agent_id: 'qc-1', selected_runtime_id: 'runtime-1' }; },
    replaceStageTask: async (...args) => { replacements.push(args); return { taskId: 'new-qc' }; }
  });
  assert.equal(task.taskId, 'new-qc');
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /u\.task_id = wrong\.id/);
  assert.doesNotMatch(calls[0].sql, /u\.issue_id = i\.id/);
  assert.deepEqual(owners[0].slice(1), ['workspace-1', 'In Progress', 'In Review']);
  assert.equal(replacements[0][1].agentId, 'qc-1');
  assert.equal(replacements[0][1].toStage, 'In Review');
  const refused = await recover({ query: async () => ({ rows: [] }) }, id, {
    selectStageOwner: async () => { throw new Error('must not select'); }, replaceStageTask: async () => { throw new Error('must not insert'); }
  });
  assert.equal(refused, null, 'wrong status, started/used, or active successor are SQL-refused');
});
