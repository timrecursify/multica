'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { qcEscalationPreference, selectPoolOwner } = require('./multica-bridge.cjs');

// qcEscalationPreference issues exactly one counting query, so the stub answers
// with the bounce count regardless of the SQL it is handed.
function countingClient(n) {
  return { query: async () => ({ rows: [{ n }] }) };
}

// selectPoolOwner takes an advisory lock, selects the pool, then stamps
// last_selected_at. Only the second call returns candidate rows.
function poolClient(rows) {
  let call = 0;
  const updates = [];
  const client = {
    query: async (sql, params) => {
      call += 1;
      if (call === 2) return { rows };
      if (/UPDATE relay_stage_agent_pool/.test(String(sql))) updates.push(params);
      return { rows: [] };
    },
    updates
  };
  return client;
}

// A pool member must look like a real In Review worker: selectPoolOwner drops
// any candidate whose instructions do not name the target stage.
function member(name, model, overrides = {}) {
  return {
    agent_id: name, agent_name: name, owner_id: 'o1', runtime_id: 'r1',
    archived_at: null, agent_status: 'idle',
    instructions: 'Review the implementation for this ticket in In Review.',
    model, thinking_level: 'low', max_concurrent_tasks: 1, runtime_config: {},
    selected_runtime_provider: 'codex', selected_runtime_id: 'r1',
    active_task_count: 0, last_selected_at: null,
    ...overrides
  };
}

test('no escalation preference outside In Review', async () => {
  assert.deepEqual(await qcEscalationPreference(countingClient(9), { id: 'i1' }, 'In Progress'), []);
  assert.deepEqual(await qcEscalationPreference(countingClient(9), { id: 'i1' }, 'Spec'), []);
});

test('first and second QC pass stay on the normal lane', async () => {
  assert.deepEqual(await qcEscalationPreference(countingClient(0), { id: 'i1' }, 'In Review'), []);
  assert.deepEqual(await qcEscalationPreference(countingClient(1), { id: 'i1' }, 'In Review'), []);
});

test('two failed QC passes hand the review to Sol', async () => {
  // Tim's rule, 2026-09-06: escalate on the second failure, not the third.
  assert.deepEqual(await qcEscalationPreference(countingClient(2), { id: 'i1' }, 'In Review'),
    ['gpt-5.6-sol']);
  assert.deepEqual(await qcEscalationPreference(countingClient(5), { id: 'i1' }, 'In Review'),
    ['gpt-5.6-sol']);
});

test('preferred lane wins the pool when it is eligible', async () => {
  const client = poolClient([member('luna-1', 'gpt-5.6-luna'), member('sol-esc', 'gpt-5.6-sol')]);
  const owner = await selectPoolOwner(client, 'ws', 'In Review', 'In Review',
    { preferModels: ['gpt-5.6-sol'] });
  assert.equal(owner.agent_name, 'sol-esc');
});

test('an unavailable escalation lane falls back to the normal pool', async () => {
  // A missing or offline Sol reviewer must not stall the advance: the ticket
  // still gets reviewed, just on the lane that is actually there.
  const client = poolClient([member('luna-1', 'gpt-5.6-luna')]);
  const owner = await selectPoolOwner(client, 'ws', 'In Review', 'In Review',
    { preferModels: ['gpt-5.6-sol'] });
  assert.equal(owner.agent_name, 'luna-1');
});

test('no preference leaves selection exactly as it was', async () => {
  const client = poolClient([member('luna-1', 'gpt-5.6-luna'), member('sol-esc', 'gpt-5.6-sol')]);
  const owner = await selectPoolOwner(client, 'ws', 'In Review', 'In Review', {});
  assert.equal(owner.agent_name, 'luna-1');
});
