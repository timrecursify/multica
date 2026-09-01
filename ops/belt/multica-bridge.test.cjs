const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test';
process.env.RELAY_AGENT_SECRET = process.env.RELAY_AGENT_SECRET || 'test-relay-secret';
process.env.MULTICA_WORKSPACE_ID = process.env.MULTICA_WORKSPACE_ID || 'test-workspace';

const {
  existingStageTask,
  replaceStageTask,
  ownerStageForTransition,
  ensureCompletedRelayLog,
  completedTerminalRelayLog,
  isBookkeepingTransition,
  recordBookkeepingHandoff,
  validateRelayVerdict,
  latestCompletedSolLowQcTask,
  relayVerdict,
  setTestClientFactory,
  isCicdReturn,
  consumeCicdReturnAuthorization,
  authorizeCicdReturnCapBypass,
  selectStageOwner
} = require('./multica-bridge.cjs');

const validVerdict = Object.freeze({
  issue_id: '123e4567-e89b-42d3-a456-426614174000', checker: 'BRAVO-000517',
  verdict: 'PASS', work_product_md5: 'e41d8cd98f00b204e9800998ecf8427e',
  bound_sha: '0123456789012345678901234567890123456789',
  observed_sha: '0123456789012345678901234567890123456789', failure_class: 'none',
  qualifying: true, model: 'gpt-5.6-sol', effort: 'low', idem_key: 'qc-verdict-000517'
});

test('verdict validation accepts the sanctioned CLI checker field and rejects forged lane metadata', () => {
  assert.equal(validateRelayVerdict(validVerdict), null);
  assert.equal(validateRelayVerdict({ ...validVerdict, checker: undefined }), 'invalid_checker');
  assert.equal(validateRelayVerdict({ ...validVerdict, observed_sha: 'f123456789012345678901234567890123456789' }), 'sha_binding_mismatch');
  assert.equal(validateRelayVerdict({ ...validVerdict, work_product_md5: 'not-an-md5' }), 'invalid_work_product_md5');
  assert.equal(validateRelayVerdict({ ...validVerdict, model: 'gpt-5.6-terra' }), 'invalid_qc_lane');
  assert.equal(validateRelayVerdict({ ...validVerdict, effort: 'high' }), 'invalid_qc_lane');
  assert.equal(validateRelayVerdict({ ...validVerdict, failure_class: 'invented' }), 'invalid_failure_class');
});

test('verdict checker identity is selected from the completed same-workspace Sol-low QC task', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: [{ id: 'task-1', agent_id: 'agent-1', agent_name: 'qc-sol-low', context: { head_sha: validVerdict.bound_sha } }] };
  } };
  const task = await latestCompletedSolLowQcTask(client, 'issue-1', 'workspace-1');
  assert.equal(task.agent_id, 'agent-1');
  assert.deepEqual(calls[0].values, ['issue-1', 'workspace-1']);
  assert.match(calls[0].sql, /i\.workspace_id = t\.workspace_id/);
  assert.match(calls[0].sql, /a\.workspace_id = i\.workspace_id/);
  assert.match(calls[0].sql, /t\.context->>'to_stage' = 'In Review'/);
  assert.match(calls[0].sql, /COALESCE\(a\.model, a\.runtime_config->>'model'\) = 'gpt-5\.6-sol'/);
  assert.match(calls[0].sql, /COALESCE\(a\.thinking_level, a\.runtime_config->>'reasoning_effort'\) = 'low'/);
  assert.match(calls[0].sql, /ORDER BY t\.completed_at DESC NULLS LAST/);
});

test('verdict route never trusts a caller supplied checker identity', () => {
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  assert.doesNotMatch(source, /RELAY_QC_ACTOR_ID/);
  assert.match(source, /checker_id: qcTask\.agent_id/);
  assert.match(source, /payload\.checker/);
  assert.match(source, /qcTask\.agent_name/);
  assert.match(source, /qc_task_sha_mismatch/);
  assert.match(source, /idempotency_conflict/);
});

test('verdict handler binds all evidence to the completed QC task and resists forgery', async () => {
  const attempts = new Map();
  const writes = [];
  let task = {
    id: 'task-1', agent_id: 'agent-1', agent_name: 'qc-sol-low-1',
    context: { head_sha: validVerdict.bound_sha }, result: { ...validVerdict }
  };
  const client = {
    async connect() {}, async end() {},
    async query(sql, values = []) {
      if (/FROM qc_attempt/.test(sql)) return { rows: attempts.has(values[0]) ? [attempts.get(values[0])] : [] };
      if (/SELECT id, workspace_id FROM issue/.test(sql)) return { rows: [{ id: validVerdict.issue_id, workspace_id: 'workspace-1' }] };
      if (/FROM agent_task_queue t/.test(sql)) return { rows: task ? [task] : [] };
      if (/FROM qc_verdict/.test(sql)) return { rows: [] };
      if (/INSERT INTO qc_attempt/.test(sql)) {
        const [issue_id, checker_name, verdict, work_product_md5, bound_sha, observed_head, failure_class, qualifying, model, effort, idem_key] = values;
        attempts.set(idem_key, { issue_id, checker_name, verdict, work_product_md5, bound_sha, observed_head, failure_class, qualifying, model, effort });
      }
      if (/INSERT INTO qc_verdict/.test(sql)) writes.push(values);
      return { rows: [] };
    }
  };
  setTestClientFactory(() => client);
  const call = async (payload) => {
    const res = { status: 0, body: '', writeHead(status) { this.status = status; }, end(body = '') { this.body = body; } };
    await relayVerdict({}, res, { agent_token: 'test-relay-secret', ...payload });
    return { ...res, json: JSON.parse(res.body) };
  };
  try {
    let result = await call({ ...validVerdict, checker: 'forged-human-name' });
    assert.equal(result.status, 201);
    assert.equal(writes[0][2], 'qc-sol-low-1', 'checker_name must come from QC agent, not CLI checker');
    result = await call({ ...validVerdict, idem_key: 'qc-verdict-wrong-md5', work_product_md5: 'a41d8cd98f00b204e9800998ecf8427e' });
    assert.equal(result.json.error, 'qc_task_work_product_mismatch');
    task = { ...task, result: { ...validVerdict, verdict: 'FAIL', failure_class: 'implementation', qualifying: false } };
    result = await call({ ...validVerdict, idem_key: 'qc-verdict-fail-pass' });
    assert.equal(result.json.error, 'qc_task_verdict_mismatch');
    task = null;
    result = await call({ ...validVerdict, idem_key: 'qc-verdict-cross-workspace' });
    assert.equal(result.json.error, 'completed_sol_low_qc_required');
    task = { id: 'task-1', agent_id: 'agent-1', agent_name: 'qc-sol-low-1', context: { head_sha: validVerdict.bound_sha }, result: { ...validVerdict } };
    result = await call({ ...validVerdict, checker: 'replay-forgery' });
    assert.equal(result.status, 200, 'same immutable evidence must replay despite a forged checker string');
    result = await call({ ...validVerdict, verdict: 'FAIL', failure_class: 'implementation', qualifying: false });
    assert.equal(result.json.error, 'idempotency_conflict');
  } finally {
    setTestClientFactory(null);
  }
});

test('only a named CI/CD return is eligible for a repair authorization', () => {
  assert.equal(isCicdReturn('CI/CD & Deploy', 'In Progress',
    'RETURN:In Progress — owner/repo#1 merge conflict; verify master..merge diff after rebase'), true);
  assert.equal(isCicdReturn('CI/CD & Deploy', 'In Progress', ''), false);
  assert.equal(isCicdReturn('In Review', 'In Progress',
    'RETURN:In Progress — retry'), false);
  assert.equal(isCicdReturn('CI/CD & Deploy', 'Queue',
    'RETURN:Queue — retry'), false);
  assert.equal(isCicdReturn('CI/CD & Deploy', 'In Progress',
    'RETURN:In Progress — arbitrary caller text'), false);
  assert.equal(isCicdReturn('CI/CD & Deploy', 'In Progress',
    'RETURN:In Progress — owner/repo#8 no CI runs after 20 minutes'), true);
});

test('CI/CD return authorization is consumed only by a cap bypass after admission', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: calls.length === 1 ? [{ id: 'issue-1' }] : [] };
  } };

  assert.equal(await authorizeCicdReturnCapBypass(client, 'issue-1', false), false);
  assert.equal(await authorizeCicdReturnCapBypass(client, 'issue-1', true), true);
  assert.equal(await authorizeCicdReturnCapBypass(client, 'issue-1', true), false);
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /cicd_return_consumed_at/);
  assert.match(calls[0].sql, /NOT \(COALESCE\(metadata, '\{\}'::jsonb\) \? 'cicd_return_consumed_at'\)/);
  assert.deepEqual(calls[0].values, ['issue-1']);
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  const admission = source.indexOf('const admission = crossStageExecutionAdmission');
  const authorization = source.indexOf('await authorizeCicdReturnCapBypass');
  assert.ok(admission >= 0 && authorization > admission,
    'the 202 cross-stage admission must precede authorization consumption');
  assert.match(source, /!issue\.metadata\?\.cicd_return_consumed_at/);
});

function scoper(overrides = {}) {
  return {
    agent_id: 'agent-b', agent_name: 'ppp-spec-sol-low-2', owner_id: 'agent-b',
    runtime_id: 'runtime-1', archived_at: null, agent_status: 'idle',
    instructions: 'Own Spec tickets only.', model: 'gpt-5.6-sol', thinking_level: 'low',
    selected_runtime_id: 'runtime-1', active_task_count: 0, max_concurrent_tasks: 1, ...overrides
  };
}

test('scoper pool selects the least-loaded eligible Sol-low owner', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
    return { rows: [scoper({ agent_id: 'agent-b', active_task_count: 0 }),
      scoper({ agent_id: 'agent-a', active_task_count: 1 })] };
  } };
  const owner = await selectStageOwner(client, 'workspace-1', 'Registered', 'Spec');
  assert.equal(owner.agent_id, 'agent-b');
  assert.match(calls[0].sql, /pg_advisory_xact_lock/);
  assert.match(calls[1].sql, /ORDER BY active_task_count, p.agent_id/);
});

test('configured scoper pool fails closed when no Sol-low owner is eligible', async () => {
  const client = { query: async (sql) => /pg_advisory_xact_lock/.test(sql)
    ? { rows: [] } : { rows: [scoper({ model: 'deepseek/deepseek-v4-flash-0731' })] } };
  await assert.rejects(() => selectStageOwner(client, 'workspace-1', 'Registered', 'Spec'),
    /No eligible Sol-low scoper in pool/);
});

test('configured scoper pool does not overfill an agent concurrency limit', async () => {
  const client = { query: async (sql) => /pg_advisory_xact_lock/.test(sql)
    ? { rows: [] } : { rows: [scoper({ active_task_count: 1, max_concurrent_tasks: 1 })] } };
  await assert.rejects(() => selectStageOwner(client, 'workspace-1', 'Registered', 'Spec'),
    /No eligible Sol-low scoper in pool/);
});

test('empty scoper pool preserves the canonical relay owner fallback', async () => {
  const calls = [];
  const fallback = { agent_id: 'canonical-agent' };
  const client = { query: async (sql) => {
    calls.push(sql);
    if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
    if (/FROM relay_stage_agent_pool/.test(sql)) return { rows: [] };
    return { rows: [fallback] };
  } };
  assert.equal(await selectStageOwner(client, 'workspace-1', 'Registered', 'Spec'), fallback);
  assert.match(calls[2], /FROM relay_stage_config/);
});

test('Queue -> In Progress is bookkeeping and never a paid builder dispatch', () => {
  assert.equal(isBookkeepingTransition('Queue', 'In Progress'), true);
  assert.equal(isBookkeepingTransition('Spec', 'Queue'), false);
  assert.equal(isBookkeepingTransition('In Progress', 'In Review'), false);
});

test('bookkeeping handoff links the existing builder task to the QC trigger', async () => {
  const calls = [];
  const replies = [
    { rows: [{ id: 'builder-task', agent_id: 'builder-agent', status: 'completed',
      result: { output: 'Implemented the fix; work product: PR #123' } }] },
    { rows: [{ id: 'handoff-log' }] }
  ];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return replies.shift();
  } };

  const result = await recordBookkeepingHandoff(client, 'issue-1');

  assert.deepEqual(result, { taskId: 'builder-task', relayLogId: 'handoff-log' });
  assert.match(calls[0].sql, /context->>'to_stage' = 'Queue'/);
  assert.match(calls[0].sql, /status = 'completed'/);
  assert.match(calls[0].sql, /SELECT id, agent_id, status, result/);
  assert.match(calls[1].sql, /INSERT INTO relay_run_log/);
  assert.deepEqual(calls[1].values, ['issue-1', 'builder-agent', 'builder-task']);
  assert.doesNotMatch(calls.map(({ sql }) => sql).join('\n'), /INSERT INTO agent_task_queue/);
});

test('bookkeeping handoff rejects a running predecessor even if a mock returns it', async () => {
  const calls = [];
  const client = { query: async (sql) => {
    calls.push(sql);
    return { rows: [{ id: 'running-builder', agent_id: 'builder-agent', status: 'running',
      result: { output: 'work product: PR #123' } }] };
  } };

  assert.equal(await recordBookkeepingHandoff(client, 'issue-running'), null);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls.join('\n'), /INSERT INTO relay_run_log/);
});

test('bookkeeping handoff rejects a failed predecessor and missing work product', async () => {
  for (const task of [
    { id: 'failed-builder', agent_id: 'builder-agent', status: 'completed', result: { output: 'FAILED: tests' } },
    { id: 'empty-builder', agent_id: 'builder-agent', status: 'completed', result: null }
  ]) {
    const calls = [];
    const client = { query: async (sql) => {
      calls.push(sql);
      return { rows: [task] };
    } };
    assert.equal(await recordBookkeepingHandoff(client, 'issue-invalid'), null);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls.join('\n'), /INSERT INTO relay_run_log/);
  }
});

test('bookkeeping handoff replay reuses the existing correlated relay row', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return calls.length % 2 === 1
      ? { rows: [{ id: 'builder-task', agent_id: 'builder-agent', status: 'completed',
          result: { output: 'work product: PR #123' } }] }
      : { rows: [{ id: 'handoff-log' }] };
  } };

  const first = await recordBookkeepingHandoff(client, 'issue-replay');
  const second = await recordBookkeepingHandoff(client, 'issue-replay');
  assert.deepEqual(first, { taskId: 'builder-task', relayLogId: 'handoff-log' });
  assert.deepEqual(second, { taskId: 'builder-task', relayLogId: 'handoff-log' });
  assert.equal(calls.filter(({ sql }) => /INSERT INTO relay_run_log/.test(sql)).length, 2);
  assert.match(calls[1].sql, /WHERE NOT EXISTS/);
});

test('bookkeeping handoff refuses a Queue shortcut without a builder predecessor', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: [] };
  } };

  assert.equal(await recordBookkeepingHandoff(client, 'issue-without-build'), null);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].sql, /INSERT INTO relay_run_log/);
});

test('relay dispatch gates bypass paid admission only for the bookkeeping hop', () => {
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  assert.match(source, /isExecutionStage\(to_stage\) && !parkedRelease && !bookkeepingTransition/);
  assert.match(source, /isExecutionStage\(to_stage\) && !bookkeepingTransition/);
  assert.match(source, /if \(bookkeepingTransition\) \{[\s\S]*relayLogId = bookkeepingHandoff\.relayLogId/);
});

test('transition owner selection preserves forward lanes and routes backward branches to lane owners', () => {
  assert.equal(ownerStageForTransition('Spec', 'Queue'), 'Spec');
  assert.equal(ownerStageForTransition('In Progress', 'In Review'), 'In Progress');
  assert.equal(ownerStageForTransition('In Review', 'In Progress'), 'Queue');
  assert.equal(ownerStageForTransition('Human Review', 'In Review'), 'In Progress');
  assert.equal(ownerStageForTransition('CI/CD & Deploy', 'Queue'), 'Queue');
  assert.equal(ownerStageForTransition('CI/CD & Deploy', 'In Progress'), 'Queue');
  assert.equal(ownerStageForTransition('CI/CD & Deploy', 'Spec'), 'Registered');
  assert.equal(ownerStageForTransition('Queue', 'Spec'), 'Registered');
});

function transition() {
  return {
    issueId: 'issue-1', fromStage: 'In Progress', toStage: 'In Review',
    workspaceId: 'workspace-1',
    agentId: 'agent-1', priority: 3, runtimeId: 'runtime-1',
    context: JSON.stringify({ from_stage: 'In Progress', to_stage: 'In Review' }),
    triggerSummary: 'Relay stage transition: In Progress -> In Review'
  };
}

test('stage transition supersedes stale work before enqueuing and logging its successor', async () => {
  const calls = [];
  const replies = [{ rows: [] }, { rows: [{ id: 'task-new' }] }, { rows: [{ id: 'log-new' }] }];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return replies.shift();
  } };

  const result = await replaceStageTask(client, transition());

  assert.deepEqual(result, { taskId: 'task-new', relayLogId: 'log-new' });
  assert.match(calls[0].sql, /failure_reason = 'relay_stage_transition_superseded'/);
  assert.deepEqual(calls[0].values, ['issue-1',
    ['queued', 'dispatched', 'waiting_local_directory', 'deferred'], 'In Review']);
  assert.match(calls[0].sql, /context \? 'to_stage'/);
  assert.match(calls[0].sql, /NOT LIKE 'manual%'/);
  assert.match(calls[0].sql, /'Human Review', 'Parked', 'Rejected'/);
  assert.match(calls[1].sql, /WHERE NOT EXISTS/);
  assert.match(calls[1].sql, /agent_id, issue_id, workspace_id/);
  assert.equal(calls[1].values[2], 'workspace-1');
  assert.match(calls[2].sql, /INSERT INTO relay_run_log/);
  assert.deepEqual(calls[2].values, ['issue-1', 'In Progress', 'In Review', 'agent-1', 'task-new']);
});

test('stage transition never cancels an active paid predecessor', async () => {
  const calls = [];
  const replies = [{ rows: [] }, { rows: [{ id: 'task-new' }] }, { rows: [{ id: 'log-new' }] }];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return replies.shift();
  } };
  await replaceStageTask(client, transition());
  assert.doesNotMatch(calls[0].sql, /status IN \([^)]*'running'/);
  assert.deepEqual(calls[0].values[1],
    ['queued', 'dispatched', 'waiting_local_directory', 'deferred']);
});

test('relay dispositions preserve already-running paid work', () => {
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  const disposition = source.slice(source.indexOf('async function applyDisposition'),
    source.indexOf('// The spec agent'));
  assert.doesNotMatch(disposition, /status IN \([^)]*'running'/);
  assert.match(disposition, /status IN \('queued','dispatched','waiting_local_directory','deferred'\)/);
});

test('cross-stage admission returns a bounded defer for active predecessors', () => {
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  assert.match(source, /res\.writeHead\(202, \{ 'Content-Type': 'application\/json', 'Retry-After': '15' \}\)/);
  assert.match(source, /retry_after_seconds: 15/);
  assert.match(source, /message: 'a prior relay execution is still active/);
});

test('stage transition fails before commit when no successor task exists', async () => {
  const calls = [];
  const replies = [{ rows: [] }, { rows: [] }, { rows: [] }];
  const client = { query: async (sql) => {
    calls.push(sql);
    return replies.shift();
  } };

  await assert.rejects(() => replaceStageTask(client, transition()),
    /relay successor task was not created/);
  assert.equal(calls.length, 3);
  assert.doesNotMatch(calls.join('\n'), /INSERT INTO relay_run_log/);
});

test('builder dispatcher rejects diagnosis tasks marked no_builder', async () => {
  const { replaceStageTask } = require('./multica-bridge.cjs');
  let queries = 0;
  await assert.rejects(() => replaceStageTask({ query: async () => { queries++; } }, {
    ...transition(), context: JSON.stringify({ kind: 'parked_diagnosis', no_builder: true })
  }), /no_builder diagnosis task/);
  assert.equal(queries, 0);
});

test('an already-created matching successor is linked instead of permitting a taskless transition', async () => {
  const replies = [{ rows: [] }, { rows: [] }, { rows: [{ id: 'task-existing' }] }, { rows: [] }];
  const client = { query: async () => replies.shift() };

  const result = await replaceStageTask(client, transition());

  assert.deepEqual(result, { taskId: 'task-existing', relayLogId: null });
});

test('an already-applied transition locates its existing live successor task', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: [{ id: 'task-existing' }] };
  } };

  const taskId = await existingStageTask(client, 'issue-1', 'In Review');

  assert.equal(taskId, 'task-existing');
  assert.match(calls[0].sql, /status::text = ANY/);
  assert.match(calls[0].sql, /FOR UPDATE/);
  assert.deepEqual(calls[0].values, ['issue-1',
    ['queued', 'dispatched', 'running', 'waiting_local_directory', 'deferred'], 'In Review']);
});

test('deploy close upgrades one oldest pending relay row', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return calls.length === 1 ? { rows: [{ id: 41 }, { id: 42 }] } : { rows: [] };
  } };

  const id = await ensureCompletedRelayLog(client, 'issue-1', 'CI/CD & Deploy', 'Done');

  assert.equal(id, 41);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /ORDER BY created_at, id\s+LIMIT 1/);
});

test('deploy close inserts one completed relay row when no pending row exists', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return calls.length === 2 ? { rows: [{ id: 42 }] } : { rows: [] };
  } };

  const id = await ensureCompletedRelayLog(client, 'issue-2', 'CI/CD & Deploy', 'Done');

  assert.equal(id, 42);
  assert.equal(calls.length, 2);
  assert.match(calls[1].sql, /INSERT INTO relay_run_log/);
});

test('terminal close retry reuses the existing completed row', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return calls.length === 3 ? { rows: [{ id: 43 }] } : { rows: [] };
  } };

  const id = await ensureCompletedRelayLog(client, 'issue-3', 'CI/CD & Deploy', 'Done');

  assert.equal(id, 43);
  assert.equal(calls.length, 3);
  assert.match(calls[2].sql, /status = 'completed'/);
});

test('terminal already-applied replay returns its completed relay log ID', async () => {
  const client = { query: async () => ({ rows: [{ id: 44 }] }) };
  assert.equal(await completedTerminalRelayLog(client, 'issue-4', 'Cancelled'), 44);
});

test('release admission is explicit, one-use, and resets task history by time', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  assert.match(source, /parked_release_once === true/);
  assert.match(source, /if \(!parkedRelease && !parkedDiagnosisDone && !allowedStages\.includes/);
  assert.match(source, /reason: "parked_release_required"/);
  assert.match(source, /created_at >= \$3/);
  assert.match(source, /created_at >= \$2/);
  assert.match(source, /'parked_release_once'.*'\{parked_release_at\}'/s);
});

test('lifetime rejection emits structured evidence', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  assert.match(source,
    /event: "relay_advance_rejected",\s+reason: lifetime\.reason,[\s\S]*disposition_applied: moved/);
});

test('parking records a reason and hands off one Sol-low diagnosis', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  assert.match(source, /recordParkAndQueueDiagnosis/);
  assert.match(source, /disposition === 'Parked'/);
  assert.match(source, /context->>'kind', ''\) <> 'parked_diagnosis'/);
});

test('relay request maps snake-case stage into successor task input', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  assert.match(source, /replaceStageTask\(client, \{[\s\S]*toStage: to_stage,/);
  assert.doesNotMatch(source, /\n\s*toStage,\n/);
});

test('relay stage lookups bind configuration and owners to the issue workspace', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  assert.match(source, /workspace_id = \$1 AND stage_name = \$2/);
  assert.match(source, /a\.workspace_id = rsc\.workspace_id/);
  assert.match(source, /Relay owner workspace mismatch/);
  assert.match(source, /ORDER BY rsc\.workspace_id, rsc\.id/);
});

test('terminal relay transitions are logged and Parked Done remains relay-only and PASS-gated', () => {
  const source = fs.readFileSync(require.resolve('./multica-bridge.cjs'), 'utf8');
  assert.match(source, /const terminalStages = new Set\(\["Done", "Cancelled", "Archived"\]\)/);
  assert.match(source, /const parkedDiagnosisDone = issue\.status === "Parked" && to_stage === "Done"/);
  assert.match(source, /to_stage === "Done"/);
  assert.match(source, /work_product_mismatch/);
  assert.match(source, /if \(terminalStages\.has\(to_stage\)\)/);
  assert.match(source, /ensureCompletedRelayLog\(\s*client, issue_id, issue\.status, to_stage/s);
});
