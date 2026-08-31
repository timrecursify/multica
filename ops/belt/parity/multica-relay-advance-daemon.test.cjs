const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, 'multica-relay-advance-daemon.cjs'),
  'utf8',
);

assert.match(source, /PARTITION BY c\.agent_id ORDER BY c\.created_at ASC, c\.issue_id ASC/);
assert.match(source, /SELECT i\.id AS issue_id, i\.number, i\.status AS stage, i\.created_at,/);
assert.match(source, /ORDER BY ranked\.created_at ASC, ranked\.issue_id ASC/);
assert.doesNotMatch(source, /PARTITION BY c\.agent_id ORDER BY c\.updated_at/);
assert.doesNotMatch(source, /ORDER BY ranked\.updated_at/);

console.log('requeueStrandedTasks ordering contract passed');
