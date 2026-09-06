"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const so = require("./stage-outcome.cjs");

test("typed OUTCOME line wins and validates blocked_on", () => {
  assert.deepEqual(so.parseOutcome("work\nOUTCOME: BLOCKED blocked_on=ci\n"), { outcome: "BLOCKED", blockedOn: "ci", typed: true });
  assert.deepEqual(so.parseOutcome("outcome: no_op"), { outcome: "NO_OP", blockedOn: null, typed: true });
  assert.equal(so.parseOutcome("OUTCOME: BLOCKED blocked_on=weird").blockedOn, null);
  assert.equal(so.parseOutcome("checkout timed out\nOUTCOME: BLOCKED blocked_on=checkout").blockedOn, "checkout");
  assert.equal(so.parseOutcome("checkout timed out\nOUTCOME: BLOCKED blocked_on=dependency").blockedOn, "checkout");
  assert.equal(so.parseOutcome("OUTCOME: ADVANCED blocked_on=ci").blockedOn, null);
});

test("legacy heuristics map known outputs; unknown is FAILED", () => {
  assert.equal(so.parseOutcome("QC-BLOCKED NO-SHA: coordination-only parent").outcome, "BLOCKED");
  assert.equal(so.parseOutcome("QC-BLOCKED NO-SHA: x").blockedOn, "sha");
  assert.equal(so.parseOutcome('{"verdict":"FAIL","qualifying":true}').outcome, "ADVANCED");
  assert.equal(so.parseOutcome("release blocked by queued CI").blockedOn, "ci");
  assert.deepEqual(so.parseOutcome("managed checkout timeout after 300s"), { outcome: "BLOCKED", blockedOn: "checkout", typed: false });
  assert.equal(so.parseOutcome("validated the already-merged implementation").outcome, "NO_OP");
  assert.equal(so.parseOutcome("relay transition Queue -> In Progress denied (409 transition_denied)").outcome, "ADVANCED");
  assert.equal(so.parseOutcome("relay rejected In Progress -> In Review evidence_missing").outcome, "FAILED");
  assert.equal(so.parseOutcome("BUILD-READY posted").outcome, "ADVANCED");
  assert.equal(so.parseOutcome("specification posted; now in Queue").outcome, "ADVANCED");
  assert.deepEqual(so.parseOutcome(""), { outcome: "FAILED", blockedOn: null, typed: false });
});

test("stage input hash includes current PR check-suite conclusions", () => {
  const sql = so.stageInputHashSql();
  assert.match(sql, /github_pull_request_check_suite/);
  assert.match(sql, /s\.conclusion/);
  assert.match(sql, /s\.head_sha = \(SELECT head_sha FROM pr\)/);
});

function fakeClient(responses) {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rows: responses.shift() || [] }; } };
}

test("stageEligibility: no outcome -> eligible; same hash -> not; changed hash -> eligible", async () => {
  let c = fakeClient([[]]);
  assert.equal((await so.stageEligibility(c, "i1", "Queue")).eligible, true);
  c = fakeClient([[{ outcome: "BLOCKED", blocked_on: "human", input_hash: "h1" }], [{ input_hash: "h1" }]]);
  const same = await so.stageEligibility(c, "i1", "Queue");
  assert.equal(same.eligible, false);
  assert.equal(same.reason, "outcome_unchanged:BLOCKED/human");
  c = fakeClient([[{ outcome: "BLOCKED", blocked_on: "ci", input_hash: "h1" }], [{ input_hash: "h2" }]]);
  assert.equal((await so.stageEligibility(c, "i1", "Queue")).reason, "input_changed");
});

test("recordStageOutcomes upserts one row per unrecorded completion", async () => {
  const c = fakeClient([[{ id: "t1", issue_id: "i1", stage: "In Review", output: "OUTCOME: ADVANCED" }], [{ input_hash: "h" }], []]);
  const r = await so.recordStageOutcomes(c, { logger: { log() {} } });
  assert.deepEqual(r, { scanned: 1, recorded: 1, failed: 0 });
  assert.match(c.calls[2].sql, /INSERT INTO issue_stage_outcome/);
  assert.deepEqual(c.calls[2].params, ["i1", "In Review", "ADVANCED", null, "t1", "h"]);
});

test("recordStageOutcomes persists relay evidence_missing as a non-ADVANCED outcome", async () => {
  const c = fakeClient([[{ id: "t2", issue_id: "i2", stage: "Queue", output: "relay rejected Queue -> In Progress evidence_missing" }], [{ input_hash: "h1" }], []]);
  const r = await so.recordStageOutcomes(c, { logger: { log() {} } });
  assert.deepEqual(r, { scanned: 1, recorded: 1, failed: 0 });
  assert.equal(c.calls[2].params[2], "FAILED");
  assert.notEqual(c.calls[2].params[2], "ADVANCED");
});

test("stageEligibility re-opens a stage when inputs change after evidence_missing", async () => {
  const c = fakeClient([[{ outcome: "FAILED", blocked_on: null, input_hash: "h1" }], [{ input_hash: "h2" }]]);
  const result = await so.stageEligibility(c, "i2", "Queue");
  assert.equal(result.eligible, true);
  assert.equal(result.reason, "input_changed");
});

test("stageEligibility retries FAILED after TTL but not before or at the attempt cap", async () => {
  const now = Date.parse("2026-09-05T20:00:00Z");
  const prior = { outcome: "FAILED", blocked_on: null, input_hash: "h1", outcome_at: "2026-09-05T19:45:00Z" };
  let c = fakeClient([[prior], [{ input_hash: "h1" }]]);
  assert.equal((await so.stageEligibility(c, "i3", "In Progress", { failedTtlMinutes: 30, now })).reason, "outcome_unchanged:FAILED");
  c = fakeClient([[prior], [{ input_hash: "h1" }]]);
  assert.equal((await so.stageEligibility(c, "i3", "In Progress", { failedTtlMinutes: 15, now })).reason, "failed_ttl_expired");
  c = fakeClient([[prior], [{ input_hash: "h1" }]]);
  const capped = await so.stageEligibility(c, "i3", "In Progress", { failedTtlMinutes: 15, now, attempt: 2, maxAttempts: 2 });
  assert.deepEqual({ eligible: capped.eligible, reason: capped.reason }, { eligible: false, reason: "attempt_budget_exhausted" });
});

test("stageEligibility re-arms an aged unchanged ADVANCED outcome only while still in that stage", async () => {
  const previous = process.env.MULTICA_ADVANCED_STALL_TTL_MINUTES;
  process.env.MULTICA_ADVANCED_STALL_TTL_MINUTES = "15";
  const old = new Date(Date.now() - 16 * 60 * 1000).toISOString();
  try {
    let c = fakeClient([[{ outcome: "ADVANCED", blocked_on: null, input_hash: "h1", outcome_at: old }],
      [{ input_hash: "h1", issue_status: "In Progress" }]]);
    assert.equal((await so.stageEligibility(c, "i3", "In Progress")).reason, "advanced_stall");
    c = fakeClient([[{ outcome: "ADVANCED", blocked_on: null, input_hash: "h1", outcome_at: old }],
      [{ input_hash: "h1", issue_status: "In Review" }]]);
    assert.equal((await so.stageEligibility(c, "i3", "In Progress")).eligible, false);
  } finally {
    if (previous === undefined) delete process.env.MULTICA_ADVANCED_STALL_TTL_MINUTES;
    else process.env.MULTICA_ADVANCED_STALL_TTL_MINUTES = previous;
  }
});

test("recordStageOutcomes rejects an In Progress ADVANCED result without PR evidence", async () => {
  const logs = [];
  const c = fakeClient([
    [{ id: "t3", issue_id: "i3", stage: "In Progress", output: "OUTCOME: ADVANCED" }],
    [{ has_review_evidence: false }],
    [{ input_hash: "h1" }], []
  ]);
  await so.recordStageOutcomes(c, { logger: { log: (line) => logs.push(line) } });
  assert.equal(c.calls[3].params[2], "FAILED");
  assert.match(logs[0], /missing review evidence/);
});

test("recordStageOutcomes links observed PR before validating In Progress evidence", async () => {
  const Module = require("node:module");
  const originalLoad = Module._load;
  let linked = false;
  Module._load = function(request, parent, isMain) {
    if (request === "./reconciler.cjs") return { linkObservedPullRequest: async () => { linked = true; } };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const c = fakeClient([
      [{ id: "t4", issue_id: "i4", stage: "In Progress", output: "OUTCOME: ADVANCED" }],
      [{ has_review_evidence: false }],
      [{ id: "i4", workspace_id: "w1", status: "In Progress" }],
      [{ has_review_evidence: true }],
      [{ input_hash: "h4" }], []
    ]);
    const result = await so.recordStageOutcomes(c, { logger: { log() {} }, githubCommand: () => "{}" });
    assert.deepEqual(result, { scanned: 1, recorded: 1, failed: 0 });
    assert.equal(linked, true);
    assert.equal(c.calls[5].params[2], "ADVANCED");
  } finally {
    Module._load = originalLoad;
  }
});

test("input hash ignores belt output and keys operator comments by content", () => {
  const sql = so.stageInputHashSql();
  // A builder's own comment must never re-open the stage it just reported on.
  assert.match(sql, /c\.source_task_id IS NULL/);
  assert.doesNotMatch(sql, /c\.id::text/);
  // Content, not identity, so an identical repeated operator note is not new input.
  assert.match(sql, /md5\(string_agg\(DISTINCT md5\(c\.content\)/);
});

test("typed line accepts a bare blocked_on token as well as blocked_on=", () => {
  // Observed on the live belt: workers drop the `blocked_on=` key and write the
  // reason alone. Both forms must land the same typed outcome.
  assert.deepEqual(so.parseOutcome("work\nOUTCOME: BLOCKED sha"), { outcome: "BLOCKED", blockedOn: "sha", typed: true });
  assert.deepEqual(so.parseOutcome("OUTCOME: BLOCKED dependency"), { outcome: "BLOCKED", blockedOn: "dependency", typed: true });
  assert.equal(so.parseOutcome("OUTCOME: BLOCKED nonsense").blockedOn, null);
  assert.equal(so.parseOutcome("OUTCOME: BLOCKED nonsense").typed, true);
  // A multi-word tail is still malformed and must fall through to the heuristics.
  assert.equal(so.parseOutcome("OUTCOME: BLOCKED human decision needed").typed, false);
});

test("unrecorded completions read only the newest completion per issue and stage", () => {
  const sql = so.unrecordedCompletionsSql();
  // Without this the pass rewrote one row between two sibling completions forever.
  assert.match(sql, /DISTINCT ON \(t\.issue_id, t\.context->>'to_stage'\)/);
  assert.match(sql, /ORDER BY t\.issue_id, t\.context->>'to_stage', t\.completed_at DESC/);
  assert.match(sql, /WHERE NOT EXISTS \(SELECT 1 FROM issue_stage_outcome o WHERE o\.task_id = latest\.id\)/);
});

test("one refused write does not abort the pass or the rows behind it", async () => {
  const logs = [];
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes("FROM agent_task_queue")) {
        return { rows: [
          { id: "bad", issue_id: "i1", stage: "Queue", output: "OUTCOME: FAILED" },
          { id: "good", issue_id: "i2", stage: "Spec", output: "OUTCOME: ADVANCED" }
        ] };
      }
      if (sql.includes("md5")) return { rows: [{ input_hash: "h" }] };
      if (params && params[4] === "bad") throw new Error("boom");
      return { rows: [] };
    }
  };
  const r = await so.recordStageOutcomes(client, { logger: { log: (line) => logs.push(line) } });
  assert.deepEqual(r, { scanned: 2, recorded: 1, failed: 1 });
  assert.ok(logs.some((line) => /record failed task=bad/.test(line)));
  assert.ok(calls.some((c) => c.params && c.params[4] === "good"));
});

test("a blocked_on the database refuses is retried without it", async () => {
  const logs = [];
  const written = [];
  const client = {
    query: async (sql, params) => {
      if (sql.includes("FROM agent_task_queue")) {
        return { rows: [{ id: "t9", issue_id: "i9", stage: "Queue", output: "checkout timed out\nOUTCOME: BLOCKED blocked_on=checkout" }] };
      }
      if (sql.includes("md5")) return { rows: [{ input_hash: "h" }] };
      if (params && params[3] === "checkout") throw new Error('violates check constraint "issue_stage_outcome_blocked_on_check"');
      written.push(params);
      return { rows: [] };
    }
  };
  const r = await so.recordStageOutcomes(client, { logger: { log: (line) => logs.push(line) } });
  assert.deepEqual(r, { scanned: 1, recorded: 1, failed: 0 });
  assert.deepEqual(written[0], ["i9", "Queue", "BLOCKED", null, "t9", "h"]);
  assert.ok(logs.some((line) => /blocked_on=checkout refused task=t9/.test(line)));
});
