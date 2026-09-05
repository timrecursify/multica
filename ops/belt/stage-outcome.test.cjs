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
  assert.deepEqual(r, { scanned: 1, recorded: 1 });
  assert.match(c.calls[2].sql, /INSERT INTO issue_stage_outcome/);
  assert.deepEqual(c.calls[2].params, ["i1", "In Review", "ADVANCED", null, "t1", "h"]);
});

test("recordStageOutcomes persists relay evidence_missing as a non-ADVANCED outcome", async () => {
  const c = fakeClient([[{ id: "t2", issue_id: "i2", stage: "Queue", output: "relay rejected Queue -> In Progress evidence_missing" }], [{ input_hash: "h1" }], []]);
  const r = await so.recordStageOutcomes(c, { logger: { log() {} } });
  assert.deepEqual(r, { scanned: 1, recorded: 1 });
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

test("input hash ignores belt output and keys operator comments by content", () => {
  const sql = so.stageInputHashSql();
  // A builder's own comment must never re-open the stage it just reported on.
  assert.match(sql, /c\.source_task_id IS NULL/);
  assert.doesNotMatch(sql, /c\.id::text/);
  // Content, not identity, so an identical repeated operator note is not new input.
  assert.match(sql, /md5\(string_agg\(DISTINCT md5\(c\.content\)/);
});
