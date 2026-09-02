const assert = require('node:assert/strict');
const test = require('node:test');
const { Pool } = require('pg');
const { reconcileQuotaPauses } = require('./multica-relay-advance-daemon.cjs');

const OLD_PAUSE = {
  id: 'agent-1',
  workspace_id: 'workspace-1',
  agent_name: 'DeepSeek Builder',
  paused_at: '2026-09-01T12:00:00.000Z',
  updated_at: '2026-09-01T12:00:00.000Z',
  budget_exhausted: false
};
const NOW = () => Date.parse('2026-09-01T12:16:00.000Z');
const TEST_DATABASE_URL = 'postgres://multica:multica@127.0.0.1:15436/multica?sslmode=disable';

function mockClient(responses, events) {
  return {
    async query(sql) {
      const event = sql.trim().split(/\s+/).slice(0, 2).join(' ');
      events.push(event);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next || { rowCount: 0, rows: [] };
    },
    release() { events.push('release'); }
  };
}

test('quota-pause reconciliation clears an expired pause and records its resume', async () => {
  const schema = `quota_pause_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const admin = new Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 5000 });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`CREATE TABLE ${schema}.agent (
      id text PRIMARY KEY, workspace_id text NOT NULL, name text, runtime_config jsonb, updated_at timestamptz NOT NULL)`);
    await admin.query(`CREATE TABLE ${schema}.build_budget (
      workspace_id text NOT NULL, scope text NOT NULL, state text NOT NULL,
      spent_ticks bigint NOT NULL, reserved_ticks bigint NOT NULL, limit_ticks bigint NOT NULL)`);
    await admin.query(`CREATE TABLE ${schema}.activity_log (
      workspace_id text NOT NULL, issue_id text, actor_type text NOT NULL, action text NOT NULL, details jsonb NOT NULL)`);
    await admin.query(`INSERT INTO ${schema}.agent (id, workspace_id, name, runtime_config, updated_at)
      VALUES ('agent-1', 'workspace-1', 'DeepSeek Builder',
        '{"quota_paused": true, "quota_paused_at": "2026-09-01T12:00:00.000Z"}',
        '2026-09-01T12:00:00.000Z')`);
    const dbPool = { connect: async () => {
      const client = await admin.connect();
      await client.query(`SET search_path TO ${schema}, public`);
      return client;
    } };
    await reconcileQuotaPauses({ connect: dbPool.connect, now: NOW, onError: (err) => { throw err; } });
    const agent = await admin.query(`SELECT runtime_config FROM ${schema}.agent WHERE id = 'agent-1'`);
    const activity = await admin.query(`SELECT action, details FROM ${schema}.activity_log`);
    assert.equal(agent.rows[0].runtime_config.quota_paused, undefined);
    assert.equal(agent.rows[0].runtime_config.quota_paused_at, undefined);
    assert.equal(agent.rows[0].runtime_config.quota_pause_clear_reason, 'build_budget_not_exhausted');
    assert.deepEqual(activity.rows, [{ action: 'relay_lane_resumed', details: {
      agent_id: 'agent-1', agent_name: 'DeepSeek Builder',
      paused_at: '2026-09-01T12:00:00.000Z', reason: 'build_budget_not_exhausted',
      timestamp: agent.rows[0].runtime_config.quota_pause_cleared_at
    } }]);
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

test('quota-pause clear emits its flip only after commit', async () => {
  const events = [];
  const flips = [];
  const client = mockClient([
    {},
    { rows: [OLD_PAUSE] },
    { rowCount: 1, rows: [{ cleared_at: '2026-09-01T12:16:00.000Z' }] },
    {},
    {}
  ], events);
  await reconcileQuotaPauses({ connect: async () => client, now: NOW,
    onFlip: (flip) => events.push(`flip:${flip.paused}`) && flips.push(flip) });
  assert.deepEqual(flips, [{ agent_name: 'DeepSeek Builder',
    timestamp: '2026-09-01T12:16:00.000Z', paused: false }]);
  assert.ok(events.indexOf('COMMIT') < events.indexOf('flip:false'));
});

test('quota-pause rollback emits no false clear flip', async () => {
  const events = [];
  const flips = [];
  const client = mockClient([
    {},
    { rows: [OLD_PAUSE] },
    { rowCount: 1, rows: [{ cleared_at: '2026-09-01T12:16:00.000Z' }] },
    new Error('activity insert failed'),
    {}
  ], events);
  await reconcileQuotaPauses({ connect: async () => client, now: NOW,
    onFlip: (flip) => flips.push(flip), onError: () => events.push('error') });
  assert.deepEqual(flips, []);
  assert.ok(events.includes('ROLLBACK'));
  assert.ok(!events.includes('COMMIT'));
});

test('quota-pause reconciliation absorbs rejected connections without unhandled rejections', async () => {
  const errors = [];
  const unhandled = [];
  const onUnhandledRejection = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    await assert.doesNotReject(reconcileQuotaPauses({
      connect: async () => { throw new Error('pool unavailable'); },
      onError: (err) => errors.push(err)
    }));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
  }
  assert.deepEqual(errors.map((err) => err.message), ['pool unavailable']);
  assert.deepEqual(unhandled, []);
});

test('concurrent reconciliation clears one locked agent only once', async () => {
  const firstEvents = [];
  const secondEvents = [];
  const flips = [];
  let releaseUpdate;
  const updateStarted = new Promise((resolve) => { releaseUpdate = resolve; });
  let continueUpdate;
  const updateMayFinish = new Promise((resolve) => { continueUpdate = resolve; });
  const first = {
    async query(sql) {
      const event = sql.trim().split(/\s+/).slice(0, 2).join(' ');
      firstEvents.push(event);
      if (event === 'SELECT a.id,') return { rows: [OLD_PAUSE] };
      if (event === 'UPDATE agent') {
        releaseUpdate();
        await updateMayFinish;
        return { rowCount: 1, rows: [{ cleared_at: '2026-09-01T12:16:00.000Z' }] };
      }
      return {};
    },
    release() { firstEvents.push('release'); }
  };
  const second = mockClient([{}, { rows: [] }, {}], secondEvents);
  const firstRun = reconcileQuotaPauses({ connect: async () => first, now: NOW,
    onFlip: (flip) => flips.push(flip) });
  await updateStarted;
  await reconcileQuotaPauses({ connect: async () => second, now: NOW,
    onFlip: (flip) => flips.push(flip) });
  continueUpdate();
  await firstRun;
  assert.equal(firstEvents.filter((event) => event === 'UPDATE agent').length, 1);
  assert.equal(secondEvents.filter((event) => event === 'UPDATE agent').length, 0);
  assert.equal(flips.length, 1);
});
