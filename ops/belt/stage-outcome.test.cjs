"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const so = require("./stage-outcome.cjs");

test("typed OUTCOME line wins and validates blocked_on", () => {
  assert.deepEqual(so.parseOutcome("work\nOUTCOME: BLOCKED blocked_on=ci\n"), { outcome: "BLOCKED", blockedOn: "ci", typed: true });
  assert.deepEqual(so.parseOutcome("outcome: no_op"), { outcome: "NO_OP", blockedOn: null, typed: true });
  assert.equal(so.parseOutcome("OUTCOME: BLOCKED blocked_on=weird").blockedOn, null);
  assert.equal(so.parseOutcome("OUTCOME: ADVANCED blocked_on=ci").blockedOn, null);
});

test("legacy heuristics map known outputs; unknown is FAILED", () => {
  assert.equal(so.parseOutcome("QC-BLOCKED NO-SHA: coordination-only parent").outcome, "BLOCKED");
  assert.equal(so.parseOutcome("QC-BLOCKED NO-SHA: x").blockedOn, "sha");
  assert.equal(so.parseOutcome('{"verdict":"FAIL","qualifying":true}').outcome, "ADVANCED");
  assert.equal(so.parseOutcome("release blocked by queued CI").blockedOn, "ci");
  assert.equal(so.parseOutcome("validated the already-merged implementation").outcome, "NO_OP");
  assert.deepEqual(so.parseOutcome(""), { outcome: "FAILED", blockedOn: null, typed: false });
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
