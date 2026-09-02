#!/usr/bin/env node
const { Pool } = require('pg');

const AGE_HOURS = 24;
const INTERVAL_MS = 15 * 60 * 1000;
const WORKSPACES = [
  'da3c5c5c-a123-4567-b999-c3ed1820da00',
  'f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f',
];

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  application_name: 'multica-archiver',
});

async function archiveDoneIssues() {
  const result = await pool.query(
    `UPDATE issue
       SET status = 'Archived', updated_at = NOW()
     WHERE workspace_id = ANY($1::uuid[])
       AND status = 'Done'
       AND updated_at <= NOW() - ($2::text || ' hours')::interval
     RETURNING id`,
    [WORKSPACES, String(AGE_HOURS)],
  );
  console.log(`[multica-archiver] archived=${result.rowCount} threshold=${AGE_HOURS}h`);
}

async function run() {
  try {
    await archiveDoneIssues();
  } catch (error) {
    console.error(`[multica-archiver] ${error.message}`);
  }
}

run();
setInterval(run, INTERVAL_MS);
