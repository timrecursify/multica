const assert = require('node:assert/strict');
const test = require('node:test');
const { parseArgs, LEGACY_SQL } = require('./reconcile-qc-verdicts.cjs');

test('reconciliation is dry-run by default and only accepts explicit apply', () => {
  assert.deepEqual(parseArgs([]), { mode: 'dry-run' });
  assert.deepEqual(parseArgs(['--apply']), { mode: 'apply' });
  assert.throws(() => parseArgs(['--apply', '--dry-run']));
  assert.match(LEGACY_SQL, /t\.result->>'bound_sha'/);
  assert.match(LEGACY_SQL, /t\.result->>'work_product_md5'=v\.work_product_md5/);
});
