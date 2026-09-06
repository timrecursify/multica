#!/usr/bin/env bash
# Canonical belt release manifest. Consumers must derive their file lists from
# this table so deployment, immutable releases, guard checks, and verification
# cannot silently drift apart.
declare -a BELT_MANIFEST_SOURCE_REL=(
  multica-bridge.cjs guardrails.cjs parked-diagnosis.cjs parked-entry-audit.cjs
  github-api-adapter.cjs parity/multica-relay-advance-daemon.cjs parity/relay-dead-rows.cjs
  multica-cicd-worker.cjs cicd-deploy-evidence.cjs cicd-watchdog.cjs multica-archiver.cjs
  merged-pr-recovery-sweep.cjs belt-config-guard.sh belt-concurrency.sh workspace-root.sh
  multica-daemon-wrapper.sh daemon-health-sentinel.sh daemon-health-sentinel.cjs
  ecosystem.gsp-belt.config.js multica-bundle.py RUNBOOK_SPEC_WORKER.md
  RUNBOOK_BUILD_WORKER.md RUNBOOK_QC_WORKER.md WORKER_COMMON.md
  relay-completion-admission.cjs qc-lane.cjs reconciler.cjs stage-outcome.cjs
  transition-policy.cjs stage-routing.cjs qc-strict-evidence.cjs stage-routing.json
  qc-verdict-policy.cjs
)
declare -a BELT_MANIFEST_TARGET_REL=(
  gsp-multica/multica-bridge.cjs gsp-multica/guardrails.cjs gsp-multica/parked-diagnosis.cjs
  gsp-multica/parked-entry-audit.cjs gsp-multica/github-api-adapter.cjs
  gsp-multica/parity/multica-relay-advance-daemon.cjs gsp-multica/parity/relay-dead-rows.cjs
  multica-cicd-worker.cjs cicd-deploy-evidence.cjs cicd-watchdog.cjs multica-archiver.cjs
  merged-pr-recovery-sweep.cjs tools/belt-config-guard.sh tools/belt-concurrency.sh
  tools/workspace-root.sh gsp-multica/fleet/multica-daemon-wrapper.sh
  gsp-multica/daemon-health-sentinel.sh gsp-multica/daemon-health-sentinel.cjs
  gsp-multica/fleet/ecosystem.gsp-belt.config.js tools/multica-bundle.py
  multica-doctrine/RUNBOOK_SPEC_WORKER.md multica-doctrine/RUNBOOK_BUILD_WORKER.md
  multica-doctrine/RUNBOOK_QC_WORKER.md multica-doctrine/WORKER_COMMON.md
  gsp-multica/relay-completion-admission.cjs gsp-multica/qc-lane.cjs
  gsp-multica/reconciler.cjs gsp-multica/stage-outcome.cjs gsp-multica/transition-policy.cjs
  gsp-multica/stage-routing.cjs gsp-multica/qc-strict-evidence.cjs gsp-multica/stage-routing.json
  gsp-multica/qc-verdict-policy.cjs
)
declare -a BELT_RELEASE_MANIFEST=(
  "${BELT_MANIFEST_SOURCE_REL[@]/#/ops\/belt\/}"
  ops/gsp-belt/relay/multica-relay-advance-launcher.cjs
  ops/gsp-belt/relay/multica-relay-advance-wrapper.sh
  ops/gsp-belt/relay/multica-relay-advance-daemon.cjs
)
(( ${#BELT_MANIFEST_SOURCE_REL[@]} == ${#BELT_MANIFEST_TARGET_REL[@]} )) || {
  echo 'belt release manifest source/target length mismatch' >&2; return 1 2>/dev/null || exit 1;
}
