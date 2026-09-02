const assert = require('node:assert/strict');
const test = require('node:test');

function loadLane(env = {}) {
  const path = require.resolve('./qc-lane.cjs');
  const previous = { QC_LANE_MODELS: process.env.QC_LANE_MODELS, QC_LANE_EFFORT: process.env.QC_LANE_EFFORT };
  Object.assign(process.env, env);
  if (!('QC_LANE_MODELS' in env)) delete process.env.QC_LANE_MODELS;
  if (!('QC_LANE_EFFORT' in env)) delete process.env.QC_LANE_EFFORT;
  delete require.cache[path];
  const lane = require('./qc-lane.cjs');
  for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  delete require.cache[path];
  return lane;
}

test('QC lane defaults accept Sol and Luna at low effort', () => {
  const lane = loadLane();
  assert.deepEqual(lane.qcLaneModelsSqlArray(), ['gpt-5.6-sol', 'gpt-5.6-luna']);
  assert.equal(lane.isQcLane('gpt-5.6-luna', 'low'), true);
  assert.equal(lane.isQcLane('gpt-5.6-luna', 'high'), false);
});

test('QC lane respects model and effort overrides', () => {
  const lane = loadLane({ QC_LANE_MODELS: 'custom-a, custom-b', QC_LANE_EFFORT: 'medium' });
  assert.deepEqual(lane.qcLaneModelsSqlArray(), ['custom-a', 'custom-b']);
  assert.equal(lane.isQcLane('custom-b', 'medium'), true);
  assert.equal(lane.isQcLane('gpt-5.6-sol', 'medium'), false);
});
