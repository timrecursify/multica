const assert = require('node:assert/strict');
const test = require('node:test');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test';
process.env.RELAY_AGENT_SECRET = process.env.RELAY_AGENT_SECRET || 'test-relay-secret';
process.env.MULTICA_WORKSPACE_ID = process.env.MULTICA_WORKSPACE_ID || 'test-workspace';

const { existingStageTask, replaceStageTask } = require('./multica-bridge.cjs');

function transition() {
  return {
    issueId: 'issue-1', fromStage: 'In Progress', toStage: 'In Review',
    agentId: 'agent-1', priority: 3, runtimeId: 'runtime-1',
    context: JSON.stringify({ from_stage: 'In Progress', to_stage: 'In Review' }),
    triggerSummary: 'Relay stage transition: In Progress -> In Review'
  };
}

test('stage transition supersedes stale work before enqueuing and logging its successor', async () => {
  const calls = [];
  const replies = [{ rows: [] }, { rows: [{ id: 'task-new' }] }, { rows: [{ id: 'log-new' }] }];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return replies.shift();
  } };

  const result = await replaceStageTask(client, transition());

  assert.deepEqual(result, { taskId: 'task-new', relayLogId: 'log-new' });
  assert.match(calls[0].sql, /failure_reason = 'relay_stage_transition_superseded'/);
  assert.deepEqual(calls[0].values, ['issue-1',
    ['queued', 'dispatched', 'running', 'waiting_local_directory', 'deferred'], 'In Review']);
  assert.match(calls[1].sql, /WHERE NOT EXISTS/);
  assert.match(calls[2].sql, /INSERT INTO relay_run_log/);
  assert.deepEqual(calls[2].values, ['issue-1', 'In Progress', 'In Review', 'agent-1', 'task-new']);
});

test('stage transition fails before commit when no successor task exists', async () => {
  const calls = [];
  const replies = [{ rows: [] }, { rows: [] }, { rows: [] }];
  const client = { query: async (sql) => {
    calls.push(sql);
    return replies.shift();
  } };

  await assert.rejects(() => replaceStageTask(client, transition()),
    /relay successor task was not created/);
  assert.equal(calls.length, 3);
  assert.doesNotMatch(calls.join('\n'), /INSERT INTO relay_run_log/);
});

test('an already-created matching successor is linked instead of permitting a taskless transition', async () => {
  const replies = [{ rows: [] }, { rows: [] }, { rows: [{ id: 'task-existing' }] }, { rows: [] }];
  const client = { query: async () => replies.shift() };

  const result = await replaceStageTask(client, transition());

  assert.deepEqual(result, { taskId: 'task-existing', relayLogId: null });
});

test('an already-applied transition locates its existing live successor task', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: [{ id: 'task-existing' }] };
  } };

  const taskId = await existingStageTask(client, 'issue-1', 'In Review');

  assert.equal(taskId, 'task-existing');
  assert.match(calls[0].sql, /status::text = ANY/);
  assert.match(calls[0].sql, /FOR UPDATE/);
  assert.deepEqual(calls[0].values, ['issue-1',
    ['queued', 'dispatched', 'running', 'waiting_local_directory', 'deferred'], 'In Review']);
});

test('release admission is explicit, one-use, and resets task history by time', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  assert.match(source, /parked_release_once === true/);
  assert.match(source, /if \(!parkedRelease && !allowedStages\.includes/);
  assert.match(source, /reason: "parked_release_required"/);
  assert.match(source, /created_at >= \$3/);
  assert.match(source, /created_at >= \$2/);
  assert.match(source, /'parked_release_once'.*'\{parked_release_at\}'/s);
});

test('lifetime rejection emits structured evidence', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  assert.match(source,
    /event: "relay_advance_rejected",\s+reason: lifetime\.reason,[\s\S]*disposition_applied: moved/);
});

test('parking records a reason and hands off one Sol-low diagnosis', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  assert.match(source, /recordParkAndQueueDiagnosis/);
  assert.match(source, /disposition === 'Parked'/);
});

test('relay request maps snake-case stage into successor task input', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  assert.match(source, /replaceStageTask\(client, \{[\s\S]*toStage: to_stage,/);
  assert.doesNotMatch(source, /\n\s*toStage,\n/);
});

test('relay stage lookups bind configuration and owners to the issue workspace', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  assert.match(source, /workspace_id = \$1 AND stage_name = \$2/);
  assert.match(source, /a\.workspace_id = rsc\.workspace_id/);
  assert.match(source, /Relay owner workspace mismatch/);
  assert.match(source, /ORDER BY rsc\.workspace_id, rsc\.id/);
});
