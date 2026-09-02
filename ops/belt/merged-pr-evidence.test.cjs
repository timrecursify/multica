const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
process.env.JWT_SECRET ||= 'test';
process.env.DATABASE_URL ||= 'postgres://test';
process.env.RELAY_AGENT_SECRET ||= 'relay';
process.env.MULTICA_WORKSPACE_ID ||= 'test-workspace';
const { mergedPrEvidence } = require('./multica-bridge.cjs');
const { durableCursor, recordCursor } = require('./merged-pr-recovery-sweep.cjs');

test('merged evidence fails before querying for a non-full SHA', async () => {
  const result = await mergedPrEvidence({ query: async () => { throw new Error('must not query'); } },
    { id: 'issue' }, { sha: 'deadbeef' });
  assert.deepEqual(result, { ok: false, reason: 'invalid_sha' });
});

test('recovery cursor is stored durably in activity_log and restored after restart', async () => {
  const calls = [];
  const db = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.startsWith('SELECT details')) return { rows: [{ cursor: 'cursor-1' }] };
    return { rows: [] };
  } };
  assert.equal(await durableCursor(db), 'cursor-1');
  await recordCursor(db, 'cursor-2');
  assert.match(calls[0].sql, /activity_log/);
  assert.deepEqual(calls[1].values.slice(1), ['cursor-2']);
});

test('recovery worker is scheduled and deployable as a PM2 service', () => {
  const worker = fs.readFileSync(require.resolve('./merged-pr-recovery-sweep.cjs'), 'utf8');
  const ecosystem = fs.readFileSync(require.resolve('./ecosystem.gsp-belt.config.js'), 'utf8');
  const deploy = fs.readFileSync(require.resolve('./deploy.sh'), 'utf8');
  assert.match(worker, /setInterval\(\(\) => sweep\(\)/);
  assert.match(worker, /pg_advisory_xact_lock/);
  assert.match(ecosystem, /merged-pr-recovery-sweep/);
  assert.match(deploy, /merged-pr-recovery-sweep\.cjs/);
});
