const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const { currentStrictPass, STRICT_CURRENT_PASS_SQL } = require('./qc-strict-evidence.cjs');

test('strict evidence requires a bound attempt, completed relay task, and Sol-low lane', async () => {
  assert.match(STRICT_CURRENT_PASS_SQL, /qa\.bound_sha ~\* '\^\[0-9a-f\]\{40\}\$'/);
  assert.match(STRICT_CURRENT_PASS_SQL, /lower\(qa\.bound_sha\)=lower\(qa\.observed_head\)/);
  assert.match(STRICT_CURRENT_PASS_SQL, /t\.status='completed'/);
  assert.match(STRICT_CURRENT_PASS_SQL, /a\.model='gpt-5\.6-sol'/);
  const db = { query: async () => ({ rows: [] }) };
  assert.equal(await currentStrictPass(db, 'issue'), null);
});

test('binding migration fails closed with a stable reason', () => {
  const migration = fs.readFileSync(require.resolve('../../server/migrations/303_qc_attempt_binding_required.up.sql'), 'utf8');
  assert.match(migration, /qc_attempt_binding_required/);
  assert.match(migration, /CREATE TRIGGER qc_verdict_attempt_binding/);
});
