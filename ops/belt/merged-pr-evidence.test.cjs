const assert = require('node:assert/strict');
const test = require('node:test');
process.env.JWT_SECRET ||= 'test';
process.env.DATABASE_URL ||= 'postgres://test';
process.env.RELAY_AGENT_SECRET ||= 'relay';
process.env.MULTICA_WORKSPACE_ID ||= 'test-workspace';
const { mergedPrEvidence } = require('./multica-bridge.cjs');

test('merged evidence fails before querying for a non-full SHA', async () => {
  const result = await mergedPrEvidence({ query: async () => { throw new Error('must not query'); } },
    { id: 'issue' }, { sha: 'deadbeef' });
  assert.deepEqual(result, { ok: false, reason: 'invalid_sha' });
});
