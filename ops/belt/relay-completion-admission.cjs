'use strict';

// A native task may exit with status=completed after the agent has reported a
// blocker.  This gate consumes only the bounded result envelope emitted by the
// daemon and the explicit outcome markers required by the worker runbooks.  It
// intentionally does not search arbitrary prose for words such as "blocked" or
// "fail": valid work often discusses an earlier failed attempt.

const EXPLICIT_OUTCOMES = new Map([
  ['blocked', 'completion_blocked'],
  ['qc-blocked', 'completion_qc_blocked'],
  ['spec-blocked', 'completion_spec_blocked'],
  ['build-blocked', 'completion_build_blocked'],
  ['fail', 'completion_failed'],
  ['failed', 'completion_failed']
]);

const RESULT_MARKERS = [
  [/^\s*QC[- ]BLOCKED\b(?:\s*[:—-]|\s*$)/im, 'completion_qc_blocked'],
  [/^\s*(?:SPEC|BUILD)[- ]BLOCKED\b(?:\s*[:—-]|\s*$)/im, 'completion_blocked'],
  [/^\s*BLOCKED(?:\s+ON\s+VERIFICATION)?\b(?:\s*[:—-]|\s*$)/im, 'completion_blocked'],
  [/^\s*QC\s+VERDICT\s*:\s*(?:FAIL|FAILED)\b/im, 'completion_failed'],
  [/^\s*FAIL(?:ED)?\s*(?:[:—-]\s*|\s*$)/im, 'completion_failed'],
  [/^\s*(?:RESULT|OUTCOME)\s*:\s*(?:FAIL|FAILED|BLOCKED)\b/im, 'completion_failed']
];

// These are complete-line declarations, not substring matches.  In
// particular, "No commit or PR needed for a docs-only change" is valid prose,
// while a worker returning exactly "No work product" is not a completion.
const NO_WORK_PRODUCT = /^\s*(?:NO\s+WORK\s+PRODUCT(?:\s+(?:WAS\s+)?(?:PRODUCED|CREATED|AVAILABLE))?|WORK\s+PRODUCT\s*:\s*(?:NONE|MISSING|N\/A))\s*[.!]?\s*$/im;

function asEnvelope(result) {
  if (result == null) return null;
  if (Buffer.isBuffer(result)) result = result.toString('utf8');
  if (typeof result === 'string') {
    const trimmed = result.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' ? parsed : { output: trimmed };
    } catch {
      // Legacy rows may contain the plain comment rather than the JSON
      // envelope.  It is still eligible for the explicit line markers.
      return { output: result };
    }
  }
  return typeof result === 'object' ? result : null;
}

function normalizedOutcome(value) {
  if (typeof value !== 'string') return null;
  return EXPLICIT_OUTCOMES.get(value.trim().toLowerCase().replace(/[ _]+/g, '-')) || null;
}

function textFields(envelope) {
  return [envelope.output, envelope.comment, envelope.error]
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean);
}

function completionAdmission(result) {
  const rejected = (reason) => ({
    ok: false, reason, disposition: 'Spec', escalation: 'sol_low_respec'
  });
  const envelope = asEnvelope(result);
  if (!envelope) return rejected('missing_result');

  if (Object.prototype.hasOwnProperty.call(envelope, 'work_product')
      && !String(envelope.work_product || '').trim()) {
    return rejected('completion_no_work_product');
  }

  const texts = textFields(envelope);
  if (texts.length === 0) return rejected('missing_result');

  for (const field of ['status', 'verdict', 'outcome']) {
    const reason = normalizedOutcome(envelope[field]);
    if (reason) return rejected(reason);
  }

  for (const text of texts) {
    if (NO_WORK_PRODUCT.test(text)) {
      return rejected('completion_no_work_product');
    }
    for (const [marker, reason] of RESULT_MARKERS) {
      if (marker.test(text)) return rejected(reason);
    }
  }

  return { ok: true };
}

function deploymentCompletionAdmission(taskStatus, result) {
  if (taskStatus !== 'completed') {
    return { ok: false, reason: `task_${taskStatus || 'missing'}_not_completed`, disposition: 'Spec', escalation: 'sol_low_respec' };
  }
  return completionAdmission(result);
}

module.exports = { completionAdmission, deploymentCompletionAdmission };
