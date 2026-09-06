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

// Luna is the belt's build lane. The DeepSeek and Terra routes it replaces are
// kept admissible so a pinned agent still runs, but nothing new is routed to
// them. The deepseek prefix stays a family match: those model ids carry a
// provider prefix and a dated suffix.
const DEFAULT_BUILD_LANE_MODELS = "gpt-5.6-luna,gpt-5.6-terra";
const BUILD_LANE_MODELS = new Set((process.env.BUILD_LANE_MODELS || DEFAULT_BUILD_LANE_MODELS)
  .split(",").map((model) => model.trim()).filter(Boolean));

function isBuildLane(model) {
  return /^deepseek[/:]/.test(String(model)) || BUILD_LANE_MODELS.has(model);
}

function buildLaneModelsSqlArray() {
  return [...BUILD_LANE_MODELS];
}

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

module.exports = { QC_LANE_MODELS, QC_LANE_EFFORT, SPEC_LANE_MODELS, BUILD_LANE_MODELS,
  isQcLane, qcLaneModelsSqlArray, isSpecLane, specLaneModelsSqlArray,
  isBuildLane, buildLaneModelsSqlArray };
