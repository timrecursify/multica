'use strict';
// GSP-2332 follow-on: selectRetryEscalationOwner hard-coded gpt-5.6-sol, so the
// GSP workspace's opus Spec owner was rejected and every retry escalation threw
// "Sol-low re-spec owner has invalid lane: gsp-spec-sol-low-public" instead of
// handing the ticket back for a re-spec. guardrails.cjs already admitted that
// agent through isSpecLane; this path was the one place still naming a model.
const test = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET ||= 'test';
process.env.DATABASE_URL ||= 'postgres://test/test';
process.env.RELAY_AGENT_SECRET ||= 'test';
process.env.ARCHIVER_AGENT_SECRET ||= 'test';
process.env.MULTICA_WORKSPACE_ID ||= '00000000-0000-0000-0000-000000000000';

const { selectRetryEscalationOwner } = require('./multica-bridge.cjs');

// selectPoolOwner takes the advisory lock, then selects the pooled owner.
function clientReturning(owner) {
  let call = 0;
  return { query: async () => (++call === 1 ? { rows: [] } : { rows: owner ? [owner] : [] }) };
}
function ownerRow(model, thinking_level) {
  return {
    agent_id: 'a1', agent_name: 'gsp-spec-sol-low-public', owner_id: 'o1',
    runtime_id: 'r1', archived_at: null, agent_status: 'idle', instructions: '',
    model, thinking_level, max_concurrent_tasks: 1, runtime_config: {},
    selected_runtime_provider: 'codex', selected_runtime_id: 'r1', active_task_count: 0,
  };
}
async function laneErrorFor(model, effort) {
  try {
    await selectRetryEscalationOwner(clientReturning(ownerRow(model, effort)), { workspace_id: 'w1', id: 'i1' });
    return null;
  } catch (err) {
    return /invalid lane/.test(err.message) ? err.message : null;
  }
}

test('the opus spec lane is admitted as a re-spec owner', async () => {
  assert.equal(await laneErrorFor('claude-opus-4-6', 'low'), null);
});

test('the sol-low QC lane remains admitted', async () => {
  assert.equal(await laneErrorFor('gpt-5.6-sol', 'low'), null);
});

test('a model on neither lane is still rejected', async () => {
  assert.match(await laneErrorFor('z-ai/glm-5.3-flash', 'low') || '', /invalid lane/);
});

test('the right model at the wrong effort is still rejected', async () => {
  assert.match(await laneErrorFor('claude-opus-4-6', 'high') || '', /invalid lane/);
});
