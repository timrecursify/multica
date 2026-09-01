const assert = require('node:assert/strict');
const test = require('node:test');
const {
  PARKED_ENTRY_LOG_SQL,
  PARKED_FLOW_PER_HOUR_SQL,
  parkedEntryAudit,
  recordParkedEntry
} = require('./parked-entry-audit.cjs');

test('Parked entry audit preserves trigger, intended stage, attempts, and task count', () => {
  assert.deepEqual(parkedEntryAudit({
    trigger: 'stage_cycle_limit', intendedStage: 'In Review', attempts: 2, taskCount: 3
  }), {
    trigger: 'stage_cycle_limit', intended_stage: 'In Review', attempts: 2, task_count: 3
  });
});

test('Parked entry writer creates one completed relay log row with audit JSON', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: [{ id: 'parked-log' }] };
  } };

  const id = await recordParkedEntry(client, {
    issueId: 'issue-1', fromStage: 'In Review', trigger: 'qc_bounce_ceiling',
    intendedStage: 'In Progress', attempts: 2, taskCount: 2
  });

  assert.equal(id, 'parked-log');
  assert.equal(calls[0].sql, PARKED_ENTRY_LOG_SQL);
  assert.match(calls[0].sql, /to_stage, status, parked_audit/);
  assert.deepEqual(calls[0].values.slice(0, 2), ['issue-1', 'In Review']);
  assert.deepEqual(JSON.parse(calls[0].values[2]), {
    trigger: 'qc_bounce_ceiling', intended_stage: 'In Progress', attempts: 2, task_count: 2
  });
});

test('hourly Parked flow query counts entries and exits separately', () => {
  assert.match(PARKED_FLOW_PER_HOUR_SQL, /date_trunc\('hour', created_at\)/);
  assert.match(PARKED_FLOW_PER_HOUR_SQL, /to_stage = 'Parked'.*entries_per_hour/s);
  assert.match(PARKED_FLOW_PER_HOUR_SQL, /from_stage = 'Parked' AND to_stage <> 'Parked'/);
  assert.match(PARKED_FLOW_PER_HOUR_SQL, /exits_per_hour/);
});
