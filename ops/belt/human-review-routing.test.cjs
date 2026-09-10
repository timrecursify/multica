"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { humanReviewDestination } = require("./human-review-routing.cjs");

test("money ticket routes to Human Review", () => {
  assert.equal(humanReviewDestination({ title: "Issue refund for a client overcharge" }), "Human Review");
});
test("structural ticket routes to Human Review", () => {
  assert.equal(humanReviewDestination({ title: "Replace canonical relay component" }), "Human Review");
});
test("ordinary bug routes to Astra-owned Spec", () => {
  assert.equal(humanReviewDestination({ title: "Fix issue list sorting bug" }), "Spec");
});
test("UNCLASSIFIED ticket routes to Astra-owned Spec", () => {
  assert.equal(humanReviewDestination({ title: "UNCLASSIFIED" }), "Spec");
});
