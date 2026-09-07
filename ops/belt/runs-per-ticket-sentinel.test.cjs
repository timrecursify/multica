'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runRunsPerTicketSentinel } = require('./runs-per-ticket-sentinel.cjs');

test('production entry point counts started executions and deduplicates breach alerts', async () => {
  const rows = [];
  for (let i = 0; i < 51; i++) {
    rows.push({ ticket_id: `ticket-${i % 20}`, execution_key: `run-${i}`, started_at: '2026-09-04T00:00:00Z', cause: 'retry' });
  }
  // Repeated queued observation of an admitted run must not increase the count.
  rows.push({ ...rows[0] }, { ...rows[1], started_at: null });
  const client = { calls: 0, async query() { this.calls++; return { rows }; } };
  const alerts = [];
  const options = { windowStart: '2026-09-04T00:00:00Z', windowEnd: '2026-09-05T00:00:00Z', emitAlert: (a) => alerts.push(a) };
  const first = await runRunsPerTicketSentinel(client, options);
  const second = await runRunsPerTicketSentinel(client, options);
  assert.equal(client.calls, 2);
  assert.equal(first.numerator, 51);
  assert.equal(first.denominator, 20);
  assert.equal(first.ratio, 2.55);
  assert.equal(alerts.length, 1);
  assert.deepEqual(Object.keys(alerts[0]).sort(), ['denominator', 'numerator', 'ratio', 'threshold', 'topCauses', 'type', 'windowEnd', 'windowStart'].sort());
  assert.equal(second.alert, null);
});
