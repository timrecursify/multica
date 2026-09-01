const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

test('relay daemon scopes stage configuration to each issue workspace', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  assert.match(source, /rsc\.workspace_id = i\.workspace_id/);
  assert.match(source, /a\.workspace_id = rsc\.workspace_id/);
});

test('Registered discovery covers every configured workspace', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  assert.match(source, /EXISTS \(SELECT 1 FROM relay_stage_config rsc/);
  assert.doesNotMatch(source, /i\.workspace_id = \$2/);
  assert.doesNotMatch(source, /\) < \$3/);
  assert.match(source, /client\.query\(query, \['Registered', STAGE_CYCLE_LIMIT\]\)/);
});

test('dispositions do not cancel paid tasks that already started', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  const disposition = source.slice(source.indexOf('async function applyDisposition'),
    source.indexOf('const configuredPoolMax'));
  assert.doesNotMatch(disposition, /status IN \([^)]*running/);
  assert.match(disposition, /status IN \('queued','dispatched','waiting_local_directory','deferred'\)/);
});
