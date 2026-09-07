'use strict';
// GSP-2329: rejected QC evidence was re-read every cycle. A rejected verdict
// writes no qc_verdict row, so the candidate query's NOT EXISTS stayed true
// forever, and ESCALATE returned before recording the claim that would have
// stopped it.
const test = require('node:test');
const assert = require('node:assert');
const {
  commentQcEvidenceRejection, claimQcEvidenceRejection, convertCompletedQcEvidence,
} = require('./relay-dead-rows.cjs');

const TASK = { id: 't-1', issue_id: 'i-1', workspace_id: 'w-1' };

// Records every statement, and reports the claiming UPDATE as succeeding or
// as already claimed.
function recordingClient({ claimRows = 1 } = {}) {
  const statements = [];
  return {
    statements,
    query: async (sql, params) => {
      statements.push({ sql, params });
      if (/UPDATE issue SET metadata/.test(sql)) return { rowCount: claimRows, rows: [] };
      return { rowCount: 0, rows: [] };
    },
  };
}
const claims = (c) => c.statements.filter((s) => /UPDATE issue SET metadata/.test(s.sql));
const comments = (c) => c.statements.filter((s) => /INSERT INTO comment/.test(s.sql));

test('an ESCALATE verdict is claimed even though it gets no ticket comment', async () => {
  const client = recordingClient();
  await commentQcEvidenceRejection(client, TASK, { reason: 'escalate-verdict' });
  assert.equal(claims(client).length, 1, 'ESCALATE must record a claim');
  assert.equal(comments(client).length, 0, 'ESCALATE must not comment');
});

test('the claim key is the task id alone, so a re-QC is never suppressed', async () => {
  const client = recordingClient();
  await claimQcEvidenceRejection(client, TASK);
  assert.deepEqual(claims(client)[0].params, ['i-1', 't-1']);
});

test('a rejected verdict still comments once it has claimed', async () => {
  const client = recordingClient();
  await commentQcEvidenceRejection(client, TASK, { reason: 'invalid-qualifying' });
  assert.equal(claims(client).length, 1);
  assert.equal(comments(client).length, 1);
});

test('an already-claimed task neither re-comments nor re-claims', async () => {
  const client = recordingClient({ claimRows: 0 });
  await commentQcEvidenceRejection(client, TASK, { reason: 'invalid-qualifying' });
  assert.equal(comments(client).length, 0);
});

test('the candidate query excludes tasks whose evidence was already rejected', async () => {
  const client = recordingClient();
  await convertCompletedQcEvidence(client, { postRelay: async () => ({ status: 200 }) });
  const candidate = client.statements[0].sql;
  assert.match(candidate, /jsonb_object_keys\(/);
  assert.match(candidate, /k = t\.id::text OR k LIKE t\.id::text \|\| ':%'/);
});
