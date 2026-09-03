"use strict";

const DEFAULT_QC_LANE_MODELS = "gpt-5.6-sol,gpt-5.6-luna";
const QC_LANE_MODELS = new Set((process.env.QC_LANE_MODELS || DEFAULT_QC_LANE_MODELS)
  .split(",").map((model) => model.trim()).filter(Boolean));
const QC_LANE_EFFORT = process.env.QC_LANE_EFFORT || "low";

function isQcLane(model, effort) {
  return QC_LANE_MODELS.has(model) && effort === QC_LANE_EFFORT;
}

function qcLaneModelsSqlArray() {
  return [...QC_LANE_MODELS];
}

module.exports = { QC_LANE_MODELS, QC_LANE_EFFORT, isQcLane, qcLaneModelsSqlArray };
