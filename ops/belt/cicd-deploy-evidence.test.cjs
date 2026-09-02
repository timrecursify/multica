#!/usr/bin/env node
const assert = require('assert');
const { skInstalled, multicaInstalled, receiptContainsMerge } = require('./cicd-deploy-evidence.cjs');

assert.equal(skInstalled('e799c36', (file, args) => args[0] === '--version'
  ? 'sk 0.3.0 (commit: 97e12846)' : ''), true);
const merge = { repo: 'timrecursify/multica', num: 1, mergedAt: '2026-01-01T00:00:00Z', mergeCommit: { oid: 'merge' } };
const run = (file, args) => {
  if (file === 'gh') return JSON.stringify([{ filename: 'apps/web/app/page.tsx' }]);
  if (file === 'docker') return args[0] === 'image' ? '2026-02-01T00:00:00Z' : 'image';
  return '';
};
assert.equal(multicaInstalled(merge, run), true, 'apps/web is deployed application code');
assert.equal(receiptContainsMerge(merge, (file, args) => args.includes('merge-base') ? '' : '',
  () => ['receipt.json'], () => '{"repo":"timrecursify/multica","source_sha":"deployed"}'), true);
assert.equal(receiptContainsMerge(merge, () => { throw new Error('not ancestor'); },
  () => ['receipt.json'], () => '{"repo":"timrecursify/multica","source_sha":"unrelated"}'), false);
assert.equal(receiptContainsMerge(merge, () => '',
  () => ['receipt.json'], () => '{"repo":"timrecursify/multica","source_sha":"deployed","outcome":"refused"}'), false);
console.log('cicd deploy evidence tests passed');
