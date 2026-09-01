const assert = require('node:assert/strict');
const test = require('node:test');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test';
process.env.RELAY_AGENT_SECRET = process.env.RELAY_AGENT_SECRET || 'test';
process.env.MULTICA_WORKSPACE_ID = process.env.MULTICA_WORKSPACE_ID || 'test';
const { parseArgs } = require('./recover-in-review-qc.cjs');
test('requires exact UUID operator scope', () => {
  const id = '123e4567-e89b-12d3-a456-426614174000';
  assert.deepEqual(parseArgs(['--apply', '--issue', id, '--issue', id]).issueIds, [id, id]);
  assert.throws(() => parseArgs(['--apply', '--issue', 'bad']), /UUID/);
  assert.throws(() => parseArgs(['--issue', id]), /--apply/);
});
test('recovery admits the observed #1009/#23696 failed-orphan shape only', () => {
  const source = require('node:fs').readFileSync(require.resolve('./recover-in-review-qc.cjs'), 'utf8');
  assert.match(source, /i\.status = 'In Review'/);
  assert.match(source, /task_usage u WHERE u\.task_id = wrong\.id/);
  assert.doesNotMatch(source, /task_usage u WHERE u\.issue_id = i\.id/);
  assert.match(source, /wrong\.status = 'failed' AND wrong\.started_at IS NULL/);
  assert.match(source, /wrong\.failure_reason = 'operator_orphan_repair'/);
  assert.match(source, /live\.status IN/);
  assert.match(source, /selectStageOwner\(client, row\.workspace_id, 'In Progress', 'In Review'\)/);
  assert.match(source, /replaceStageTask/);
});
