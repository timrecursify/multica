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

test('relay advancement admits task results before creating a successor', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  assert.match(source, /require\('\.\.\/relay-completion-admission\.cjs'\)/);
  assert.match(source, /atq\.result AS task_result/);
  assert.match(source, /completionAdmission\(row\.task_result/);
  assert.match(source, /applyDisposition\(client,[\s\S]*completion\.disposition, completion\.reason/);
  assert.match(source, /markRelayLogFailedById\(client, row\.log_id\)/);
});

test('stranded-task recovery does not retry a semantically blocked completion', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  assert.match(source, /t\.result AS dead_task_result/);
  assert.match(source, /row\.dead_task_status === 'completed'/);
  assert.match(source, /completed predecessor failed completion admission/);
});

test('Registered recovery applies the same completion gate', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  const recovery = source.slice(source.indexOf('async function recoveryAdvanceTasks'),
    source.indexOf('function postToRelay'));
  assert.match(recovery, /atq\.result AS task_result/);
  assert.match(recovery, /completionAdmission\(row\.task_result/);
  assert.match(recovery, /reason=task_not_completed/);
});

test('quota pause flips are timestamped and stale unbudgeted pauses self-clear', () => {
  const source = fs.readFileSync(require.resolve('./multica-relay-advance-daemon.cjs'), 'utf8');
  assert.match(source, /'quota_paused_at', to_jsonb\(NOW\(\)\)/);
  assert.match(source, /quotaPauseFlipLogLine\(pause\.agent_name, pause\.paused_at, true\)/);
  assert.match(source, /FOR UPDATE SKIP LOCKED/);
  assert.match(source, /b\.scope = 'workspace'/);
  assert.match(source, /b\.state = 'closed'/);
  assert.match(source, /b\.spent_ticks \+ b\.reserved_ticks >= b\.limit_ticks/);
  assert.match(source, /quotaPauseFlipLogLine\(agent\.agent_name, timestamp, false\)/);
  assert.match(source, /setInterval\(reconcileQuotaPauses, 60000\)/);
});
