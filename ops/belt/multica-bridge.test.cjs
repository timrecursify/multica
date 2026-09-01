const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test';
process.env.RELAY_AGENT_SECRET = process.env.RELAY_AGENT_SECRET || 'test-relay-secret';
process.env.MULTICA_WORKSPACE_ID = process.env.MULTICA_WORKSPACE_ID || 'test-workspace';

const {
  existingStageTask,
  replaceStageTask,
  ownerStageForTransition,
  ensureCompletedRelayLog
} = require('./multica-bridge.cjs');

test('transition owner selection preserves forward lanes and routes backward branches to lane owners', () => {
  assert.equal(ownerStageForTransition('Spec', 'Queue'), 'Spec');
  assert.equal(ownerStageForTransition('In Progress', 'In Review'), 'In Progress');
  assert.equal(ownerStageForTransition('In Review', 'In Progress'), 'Queue');
  assert.equal(ownerStageForTransition('Human Review', 'In Review'), 'In Progress');
  assert.equal(ownerStageForTransition('CI/CD & Deploy', 'Queue'), 'Queue');
  assert.equal(ownerStageForTransition('CI/CD & Deploy', 'In Progress'), 'Queue');
  assert.equal(ownerStageForTransition('CI/CD & Deploy', 'Spec'), 'Registered');
  assert.equal(ownerStageForTransition('Queue', 'Spec'), 'Registered');
});

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
    ['queued', 'dispatched', 'waiting_local_directory', 'deferred'], 'In Review']);
  assert.match(calls[0].sql, /context \? 'to_stage'/);
  assert.match(calls[0].sql, /NOT LIKE 'manual%'/);
  assert.match(calls[0].sql, /'Human Review', 'Parked', 'Rejected'/);
  assert.match(calls[1].sql, /WHERE NOT EXISTS/);
  assert.match(calls[2].sql, /INSERT INTO relay_run_log/);
  assert.deepEqual(calls[2].values, ['issue-1', 'In Progress', 'In Review', 'agent-1', 'task-new']);
});

test('stage transition never cancels an active paid predecessor', async () => {
  const calls = [];
  const replies = [{ rows: [] }, { rows: [{ id: 'task-new' }] }, { rows: [{ id: 'log-new' }] }];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return replies.shift();
  } };
  await replaceStageTask(client, transition());
  assert.doesNotMatch(calls[0].sql, /status IN \([^)]*'running'/);
  assert.deepEqual(calls[0].values[1],
    ['queued', 'dispatched', 'waiting_local_directory', 'deferred']);
});

test('relay dispositions preserve already-running paid work', () => {
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  const disposition = source.slice(source.indexOf('async function applyDisposition'),
    source.indexOf('// The spec agent'));
  assert.doesNotMatch(disposition, /status IN \([^)]*'running'/);
  assert.match(disposition, /status IN \('queued','dispatched','waiting_local_directory','deferred'\)/);
});

test('cross-stage admission returns a bounded defer for active predecessors', () => {
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  assert.match(source, /res\.writeHead\(202, \{ 'Content-Type': 'application\/json', 'Retry-After': '15' \}\)/);
  assert.match(source, /retry_after_seconds: 15/);
  assert.match(source, /message: 'a prior relay execution is still active/);
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

test('builder dispatcher rejects diagnosis tasks marked no_builder', async () => {
  const { replaceStageTask } = require('./multica-bridge.cjs');
  let queries = 0;
  await assert.rejects(() => replaceStageTask({ query: async () => { queries++; } }, {
    ...transition(), context: JSON.stringify({ kind: 'parked_diagnosis', no_builder: true })
  }), /no_builder diagnosis task/);
  assert.equal(queries, 0);
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

test('deploy close upgrades one oldest pending relay row', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return calls.length === 1 ? { rows: [{ id: 41 }, { id: 42 }] } : { rows: [] };
  } };

  const id = await ensureCompletedRelayLog(client, 'issue-1', 'CI/CD & Deploy', 'Done');

  assert.equal(id, 41);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /ORDER BY created_at, id\s+LIMIT 1/);
});

test('deploy close inserts one completed relay row when no pending row exists', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return calls.length === 2 ? { rows: [{ id: 42 }] } : { rows: [] };
  } };

  const id = await ensureCompletedRelayLog(client, 'issue-2', 'CI/CD & Deploy', 'Done');

  assert.equal(id, 42);
  assert.equal(calls.length, 2);
  assert.match(calls[1].sql, /INSERT INTO relay_run_log/);
});

test('deploy close retry does not duplicate an existing completed row', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: [] };
  } };

  const id = await ensureCompletedRelayLog(client, 'issue-3', 'CI/CD & Deploy', 'Done');

  assert.equal(id, null);
  assert.equal(calls.length, 2);
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
  assert.match(source, /context->>'kind', ''\) <> 'parked_diagnosis'/);
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
