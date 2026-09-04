'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateRunsPerTicket, evaluateRunsPerTicket, RUNS_PER_TICKET_THRESHOLD } = require('./runs-per-ticket.cjs');

const event = (ticketId, executionKey, cause = 'initial') => ({ ticketId, executionKey, admitted: true, startedAt: '2026-09-04T00:00:00Z', cause });

test('counts one admitted run per ticket', () => assert.equal(calculateRunsPerTicket([event('a', '1'), event('b', '2')]).ratio, 1));
test('duplicate queue observations are idempotent', () => {
  const e = event('a', '1');
  assert.deepEqual(calculateRunsPerTicket([e, { ...e }, { ...e, admitted: false }]), { numerator: 1, denominator: 1, ratio: 1, causes: [{ cause: 'initial', count: 1 }] });
});
test('retry with a new execution key counts once', () => assert.equal(calculateRunsPerTicket([event('a', '1'), event('a', '2', 'retry')]).ratio, 2));
test('zero-ticket denominator is safe', () => assert.deepEqual(calculateRunsPerTicket([]).ratio, 0));
test('alert is deduplicated through breach and re-enabled after recovery', () => {
  const events = Array.from({ length: 51 }, (_, i) => event(`t${i % 20}`, `r${i}`, 'retry'));
  const opts = { windowStart: '2026-09-04T00:00:00Z', windowEnd: '2026-09-05T00:00:00Z' };
  const first = evaluateRunsPerTicket(events, opts);
  assert.equal(first.ratio, 2.55); assert.equal(first.alert.threshold, RUNS_PER_TICKET_THRESHOLD);
  assert.equal(evaluateRunsPerTicket(events, opts).alert, null);
  assert.equal(evaluateRunsPerTicket([], opts).breached, false);
  assert.ok(evaluateRunsPerTicket(events, opts).alert);
});
