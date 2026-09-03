'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Match the sentinel alert contract (20 minutes), so a stalled deployment is
// surfaced with an actionable reason before the external alert fires.
const SENTINEL_MS = Number(process.env.CICD_SENTINEL_MS || 1200000);
const RETRY_LIMIT = Number(process.env.CICD_RETRY_LIMIT || 5);
const RETRY_BASE_MS = Number(process.env.CICD_RETRY_BASE_MS || 5000);

function keyFor(issueId, stage = 'CI/CD & Deploy') { return `${issueId}:${stage}`; }
function correlationKey(issueId, sha = '') {
  return crypto.createHash('sha256').update(`${issueId}:${sha}`).digest('hex').slice(0, 32);
}

function createWatchdog({ file, now = () => Date.now() } = {}) {
  let state = {};
  if (file) {
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_) { state = {}; }
  }
  const persist = () => {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  };
  const observe = (issueId, { stage = 'CI/CD & Deploy', sha = '', outcome, error } = {}) => {
    const key = keyFor(issueId, stage); const t = now();
    const row = state[key] || { issue_id: issueId, stage, first_seen_at: new Date(t).toISOString(), attempts: 0,
      correlation_key: correlationKey(issueId, sha), alerted: false };
    row.last_attempt_at = new Date(t).toISOString(); row.last_seen_at = row.last_attempt_at;
    row.attempts += 1; if (sha) row.commit_sha = sha; if (outcome) row.outcome = outcome;
    if (error) row.last_error = String(error).slice(0, 500);
    state[key] = row; persist(); return row;
  };
  const retryAllowed = (row) => row.attempts <= RETRY_LIMIT && now() - Date.parse(row.first_seen_at) < SENTINEL_MS;
  const backoffMs = (row) => Math.min(RETRY_BASE_MS * (2 ** Math.max(0, row.attempts - 1)), SENTINEL_MS);
  const stalled = (row) => !row.alerted && now() - Date.parse(row.first_seen_at) >= SENTINEL_MS;
  const markAlerted = (row, outcome = 'deploy_stalled') => { row.alerted = true; row.outcome = outcome; row.alerted_at = new Date(now()).toISOString(); persist(); return row; };
  const clear = (issueId, stage = 'CI/CD & Deploy') => { delete state[keyFor(issueId, stage)]; persist(); };
  return { observe, retryAllowed, backoffMs, stalled, markAlerted, clear, snapshot: () => ({ ...state }) };
}

module.exports = { SENTINEL_MS, RETRY_LIMIT, RETRY_BASE_MS, keyFor, correlationKey, createWatchdog };
