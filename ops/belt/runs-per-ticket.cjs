'use strict';

// Accounting is deliberately based on an execution key (normally the task id),
// rather than queue observations.  A task can be seen many times while queued,
// but an admitted native execution has exactly one key.
const RUNS_PER_TICKET_THRESHOLD = 2.5;
const breachWindows = new Set();

function executionKey(event) {
  if (!event || event.admitted !== true) return null;
  const key = event.executionKey || event.runId || event.taskId;
  const ticket = event.ticketId || event.issueId;
  return key && ticket ? `${ticket}:${key}` : null;
}

function calculateRunsPerTicket(events, { windowStart, windowEnd } = {}) {
  const seen = new Set();
  const tickets = new Set();
  const causes = new Map();
  for (const event of events || []) {
    const at = event.startedAt ? new Date(event.startedAt).getTime() : NaN;
    if (windowStart && at < new Date(windowStart).getTime()) continue;
    if (windowEnd && at >= new Date(windowEnd).getTime()) continue;
    const key = executionKey(event);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    tickets.add(event.ticketId || event.issueId);
    const cause = event.cause || 'unknown';
    causes.set(cause, (causes.get(cause) || 0) + 1);
  }
  const numerator = seen.size;
  const denominator = tickets.size;
  return {
    numerator, denominator,
    ratio: denominator === 0 ? 0 : numerator / denominator,
    causes: [...causes.entries()].sort((a, b) => b[1] - a[1]).map(([cause, count]) => ({ cause, count }))
  };
}

function evaluateRunsPerTicket(events, options = {}) {
  const metric = calculateRunsPerTicket(events, options);
  const window = `${options.windowStart || ''}/${options.windowEnd || ''}`;
  const breached = metric.ratio > RUNS_PER_TICKET_THRESHOLD;
  let alert = null;
  if (breached && !breachWindows.has(window)) {
    breachWindows.add(window);
    alert = { type: 'runs_per_ticket', threshold: RUNS_PER_TICKET_THRESHOLD,
      windowStart: options.windowStart || null, windowEnd: options.windowEnd || null,
      numerator: metric.numerator, denominator: metric.denominator, ratio: metric.ratio,
      topCauses: metric.causes.slice(0, 5) };
    if (typeof options.onAlert === 'function') options.onAlert(alert);
  } else if (!breached) {
    breachWindows.delete(window);
  }
  return { ...metric, threshold: RUNS_PER_TICKET_THRESHOLD, breached, alert };
}

// Query only executions that actually started; queued, deferred and duplicate
// observations therefore cannot inflate the numerator.
function runsPerTicketQuery({ windowStart = null, windowEnd = null } = {}) {
  return {
    text: `SELECT issue_id AS ticket_id, id AS execution_key, started_at,
                  COALESCE(context->>'cause', context->>'dead_task_reason', 'unknown') AS cause
             FROM agent_task_queue
            WHERE started_at IS NOT NULL
              AND ($1::timestamptz IS NULL OR started_at >= $1)
              AND ($2::timestamptz IS NULL OR started_at < $2)`,
    values: [windowStart, windowEnd]
  };
}

module.exports = { RUNS_PER_TICKET_THRESHOLD, calculateRunsPerTicket,
  evaluateRunsPerTicket, executionKey, runsPerTicketQuery };
