"use strict";

const DEFAULT_QC_LANE_MODELS = "gpt-5.6-sol,gpt-5.6-luna";
const QC_LANE_MODELS = new Set((process.env.QC_LANE_MODELS || DEFAULT_QC_LANE_MODELS)
  .split(",").map((model) => model.trim()).filter(Boolean));
const QC_LANE_EFFORT = process.env.QC_LANE_EFFORT || "low";

// Scoping runs on the opus lane by doctrine; QC stays Sol-low. Keeping the two
// sets apart lets a *spec* agent use opus without widening what QC may run.
const DEFAULT_SPEC_LANE_MODELS = "claude-opus-4-6";
const SPEC_LANE_MODELS = new Set((process.env.SPEC_LANE_MODELS || DEFAULT_SPEC_LANE_MODELS)
  .split(",").map((model) => model.trim()).filter(Boolean));

function isQcLane(model, effort) {
  return QC_LANE_MODELS.has(model) && effort === QC_LANE_EFFORT;
}

function qcLaneModelsSqlArray() {
  return [...QC_LANE_MODELS];
}

function isSpecLane(model, effort) {
  return SPEC_LANE_MODELS.has(model) && effort === QC_LANE_EFFORT;
}

function specLaneModelsSqlArray() {
  return [...SPEC_LANE_MODELS];
}

module.exports = { QC_LANE_MODELS, QC_LANE_EFFORT, SPEC_LANE_MODELS, isQcLane, qcLaneModelsSqlArray,
  isSpecLane, specLaneModelsSqlArray };
