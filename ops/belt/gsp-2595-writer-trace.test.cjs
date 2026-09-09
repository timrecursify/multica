const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('GSP-2595 records every writer and repair boundary', () => {
  const doc = fs.readFileSync(__dirname + '/gsp-2595-writer-trace.md', 'utf8');
  for (const term of ['stage-outcome.cjs:265-269', 'recordRefusedAdvance',
    'relay_run_log', '22 stage-mismatch', '81 historical candidates',
    'explicit human']) assert.ok(doc.includes(term), term);
});
