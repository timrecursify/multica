#!/usr/bin/env node
'use strict';

const { Client } = require('pg');
const { evaluateRunsPerTicket, runsPerTicketQuery } = require('./runs-per-ticket.cjs');

/** Run the production runs-per-ticket check against the queue database. */
async function runRunsPerTicketSentinel(client, options = {}) {
  const query = runsPerTicketQuery(options);
  const result = await client.query(query.text, query.values);
  const events = (result.rows || []).map((row) => ({
    ticketId: row.ticket_id,
    executionKey: row.execution_key,
    startedAt: row.started_at,
    cause: row.cause,
    // The query only admits executions with a start timestamp.
    admitted: true
  }));
  const evaluation = evaluateRunsPerTicket(events, options);
  if (evaluation.alert && typeof options.emitAlert === 'function') {
    await options.emitAlert(evaluation.alert);
  }
  return evaluation;
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - 60 * 60 * 1000);
    const result = await runRunsPerTicketSentinel(client, {
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      emitAlert: (alert) => process.stdout.write(`${JSON.stringify(alert)}\n`)
    });
    if (!result.breached) process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await client.end();
  }
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });

module.exports = { runRunsPerTicketSentinel };
