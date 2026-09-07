"use strict";

// Fleet routing authority. Every belt consumer, including generated worker
// instructions and the daemon-wrapper preflight, reads this table.
const ROUTING_CONFIG = Object.freeze({
  provider: "codex",
  providerFamily: "openai",
  effort: "low",
  lanes: Object.freeze({
    build: Object.freeze(["gpt-5.6-luna"]),
    qc: Object.freeze(["gpt-5.6-sol", "gpt-5.6-luna"]),
    spec: Object.freeze(["gpt-6-astra"]),
  }),
});

const QC_LANE_MODELS = new Set(ROUTING_CONFIG.lanes.qc);
const SPEC_LANE_MODELS = new Set(ROUTING_CONFIG.lanes.spec);
const BUILD_LANE_MODELS = new Set(ROUTING_CONFIG.lanes.build);
const ALLOWED_MODELS = new Set(Object.values(ROUTING_CONFIG.lanes).flat());
const QC_LANE_EFFORT = ROUTING_CONFIG.effort;

function isBuildLane(model) {
  return BUILD_LANE_MODELS.has(model);
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

// QC escalation lane. Tim's standing rule (2026-09-06): two failed Luna QC
// passes hand the review to Sol immediately, rather than running Luna a third
// time or ending the ticket. gsp-qc-esc-1 is the Sol reviewer this selects.
const QC_ESCALATION_MODELS = new Set(["gpt-5.6-sol"]);

// Two is Tim's number, not a derived one. Kept in env so the lane can be tuned
// without a deploy.
const QC_ESCALATION_BOUNCES = Number.parseInt(process.env.QC_ESCALATION_BOUNCES || "2", 10);

function qcEscalationModels() {
  return [...QC_ESCALATION_MODELS];
}

function isQcEscalationLane(model) {
  return QC_ESCALATION_MODELS.has(model);
}

function isSpecLane(model, effort) {
  return SPEC_LANE_MODELS.has(model) && effort === QC_LANE_EFFORT;
}

function specLaneModelsSqlArray() {
  return [...SPEC_LANE_MODELS];
}

function daemonRouteAdmission(providers, model) {
  const providerList = String(providers || "").split(",")
    .map((provider) => provider.trim().toLowerCase()).filter(Boolean);
  if (providerList.length === 0) return { ok: false, reason: "provider_missing" };
  if (providerList.some((provider) => provider !== ROUTING_CONFIG.provider)) {
    return { ok: false, reason: "provider_not_allowed" };
  }
  if (!ALLOWED_MODELS.has(String(model || "").trim())) {
    return { ok: false, reason: "model_not_allowed" };
  }
  return { ok: true };
}

function workerRoutingInstructions(lane) {
  const models = ROUTING_CONFIG.lanes[lane];
  if (!models) throw new Error(`unknown belt lane: ${lane}`);
  return [
    `ROUTING_CONTRACT provider_family=${ROUTING_CONFIG.providerFamily} runtime_provider=${ROUTING_CONFIG.provider}`,
    `lane=${lane} model=${models.join("|")} effort=${ROUTING_CONFIG.effort}`,
    "Use only this generated route. A mismatch is a recoverable preflight blocker; do not substitute a provider or model.",
  ].join("\n");
}

function runCli(args) {
  const [command, first, second] = args;
  if (command === "worker-instructions") {
    process.stdout.write(`${workerRoutingInstructions(first)}\n`);
    return 0;
  }
  if (command === "validate-daemon") {
    const result = daemonRouteAdmission(first, second);
    if (!result.ok) process.stderr.write(`${result.reason}\n`);
    return result.ok ? 0 : 64;
  }
  process.stderr.write("usage: qc-lane.cjs worker-instructions <lane> | validate-daemon <providers> <model>\n");
  return 64;
}

module.exports = { QC_LANE_MODELS, QC_LANE_EFFORT, SPEC_LANE_MODELS, BUILD_LANE_MODELS,
  QC_ESCALATION_MODELS, QC_ESCALATION_BOUNCES, ROUTING_CONFIG,
  isQcLane, qcLaneModelsSqlArray, isSpecLane, specLaneModelsSqlArray,
  isBuildLane, buildLaneModelsSqlArray, qcEscalationModels, isQcEscalationLane,
  daemonRouteAdmission, workerRoutingInstructions };

if (require.main === module) process.exitCode = runCli(process.argv.slice(2));
