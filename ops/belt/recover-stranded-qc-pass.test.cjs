const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

test('stranded QC recovery selects the configured QC lane with parameterized SQL', async () => {
  const source = fs.readFileSync(require.resolve('./recover-stranded-qc-pass.cjs'), 'utf8');
  assert.match(source, /a\.model = ANY\(\$1::text\[\]\)/);
  assert.match(source, /a\.thinking_level = \$2::text/);
  assert.match(source, /client\.query\(CANDIDATE_SQL, \[qcLaneModelsSqlArray\(\), QC_LANE_EFFORT\]\)/);
});
