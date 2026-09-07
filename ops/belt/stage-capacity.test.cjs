'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const root = join(__dirname, '..', '..');
const seed = readFileSync(join(root, 'ops/gsp-belt/sql/seed-pipeline.sql'), 'utf8');
const migration = readFileSync(join(__dirname, 'sql/2026-09-07_stage_capacity.sql'), 'utf8');
const rollback = readFileSync(join(__dirname, 'sql/2026-09-07_stage_capacity.rollback.sql'), 'utf8');
const status = readFileSync(join(root, 'ops/gsp-belt/scripts/belt-status.sh'), 'utf8');

test('seed pins both live board budgets and their enabled member counts', () => {
  const expected = [
    ['gsp-multica', 'CI/CD & Deploy', 3, 45],
    ['gsp-multica', 'Human Review', 1, 15],
    ['gsp-multica', 'In Progress', 15, 450],
    ['gsp-multica', 'In Review', 5, 75],
    ['gsp-multica', 'Parked', 1, 30],
    ['gsp-multica', 'Queue', 15, 450],
    ['gsp-multica', 'Registered', 5, 150],
    ['gsp-multica', 'Spec', 5, 150],
    ['ppp-production', 'CI/CD & Deploy', 3, 45],
    ['ppp-production', 'Human Review', 1, 15],
    ['ppp-production', 'In Progress', 15, 363],
    ['ppp-production', 'In Review', 6, 90],
    ['ppp-production', 'Parked', 1, 30],
    ['ppp-production', 'Queue', 15, 363],
    ['ppp-production', 'Registered', 4, 120],
    ['ppp-production', 'Spec', 5, 150]
  ];
  for (const [workspace, stage, members, budget] of expected) {
    assert.ok(seed.includes(`('${workspace}', '${stage}', true, ${members}, ${budget})`));
  }
});

test('seed owns the current pool-agent caps and membership sets', () => {
  const capSection = seed.split('INSERT INTO seed_agent_capacity VALUES')[1]
    .split('DO $$')[0];
  const caps = [...capSection.matchAll(/\('(gsp-multica|ppp-production)', '[0-9a-f-]{36}', (\d+)\)/g)];
  assert.equal(caps.length, 57);
  assert.deepEqual(
    caps.reduce((counts, match) => {
      const key = `${match[1]}:${match[2]}`;
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {}),
    {
      'gsp-multica:1': 1,
      'gsp-multica:15': 8,
      'gsp-multica:30': 20,
      'ppp-production:1': 3,
      'ppp-production:15': 9,
      'ppp-production:30': 16
    }
  );

  const membershipSection = seed.split('INSERT INTO seed_stage_membership VALUES')[1]
    .split('INSERT INTO public.relay_stage_agent_pool')[0];
  const memberships = [...membershipSection.matchAll(/\('(gsp-multica|ppp-production)', '[^']+', '[0-9a-f-]{36}', (true|false)\)/g)];
  assert.equal(memberships.filter((match) => match[1] === 'gsp-multica').length, 52);
  assert.equal(memberships.filter((match) => match[1] === 'ppp-production').length, 50);
  assert.match(seed, /ON CONFLICT \(workspace_id, stage_name, agent_id\) DO UPDATE/);
  assert.match(seed, /NOT EXISTS \(\s+SELECT 1 FROM seed_stage_membership/);
});

test('capacity view separates relay-ready, waiting, and running work', () => {
  assert.match(migration, /relay\.status = 'pending'/);
  assert.match(migration, /task\.status = 'completed'/);
  assert.match(migration, /issue\.status = relay\.to_stage/);
  assert.match(migration, /'queued', 'dispatched', 'waiting_local_directory', 'deferred'/);
  assert.match(migration, /task\.status = 'running'/);
  assert.match(migration, /capacity_budget/);
  assert.match(migration, /available_capacity/);
  assert.equal(rollback.trim(), 'DROP VIEW IF EXISTS public.relay_stage_capacity_status;');
});

test('belt status prints stage pressure in tuning order', () => {
  assert.match(status, /workspace\|stage\|budget\|available\|ready\|waiting\|running/);
  assert.match(status, /FROM public\.relay_stage_capacity_status/);
  assert.match(status, /ORDER BY workspace_slug, stage_name/);
});
