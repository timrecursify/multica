"use strict";

const INFRA_FAILURE_REASONS = [
  'runtime_offline',
  'timeout',
  'queued_expired',
  'cancelled',
  'stream_disconnected',
  'agent_error.provider_quota_limit'
];

const QUOTA_FAILURE_RE = /\b402\b|provider_quota_limit|payment[ _-]?required/i;

module.exports = { INFRA_FAILURE_REASONS, QUOTA_FAILURE_RE };
