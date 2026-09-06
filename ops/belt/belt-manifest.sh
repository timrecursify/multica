#!/usr/bin/env bash
# Canonical belt release manifest: the one list of what ships where.
#
# deploy.sh, verify.sh and deploy.test.sh all source this file. Three separate
# copies of these arrays drifted apart and shipped a deploy that targeted a tree
# which did not exist on gsp (GSP-2327); keep them here or the drift returns.
#
# Callers must set:
#   root_dir      absolute path of this ops/belt directory
#   runtime_root  deployment root (production: /opt/gsp/multica-workers)
#
# Layout is measured from the running box, where the belt services run out of
# /opt/gsp/multica-workers/<service>/. Ten files are deployed to more than one
# service directory; transition-policy.cjs goes to three. Duplicate source rows
# are intentional -- every apply/backup/rollback loop iterates by index.

declare -a sources=(
  "$root_dir/multica-bridge.cjs"
  "$root_dir/multica-bridge.cjs"
  "$root_dir/guardrails.cjs"
  "$root_dir/guardrails.cjs"
  "$root_dir/parked-diagnosis.cjs"
  "$root_dir/parked-diagnosis.cjs"
  "$root_dir/parked-entry-audit.cjs"
  "$root_dir/parked-entry-audit.cjs"
  "$root_dir/qc-lane.cjs"
  "$root_dir/qc-lane.cjs"
  "$root_dir/qc-strict-evidence.cjs"
  "$root_dir/qc-strict-evidence.cjs"
  "$root_dir/qc-verdict-policy.cjs"
  "$root_dir/qc-verdict-policy.cjs"
  "$root_dir/relay-completion-admission.cjs"
  "$root_dir/relay-completion-admission.cjs"
  "$root_dir/stage-routing.json"
  "$root_dir/stage-routing.json"
  "$root_dir/transition-policy.cjs"
  "$root_dir/transition-policy.cjs"
  "$root_dir/transition-policy.cjs"
  "$root_dir/qc-escalate.cjs"
  "$root_dir/qc-gate.cjs"
  "$root_dir/reconciler.cjs"
  "$root_dir/stage-outcome.cjs"
  "$root_dir/stage-routing.cjs"
  "$root_dir/parity/multica-relay-advance-daemon.cjs"
  "$root_dir/parity/relay-dead-rows.cjs"
  "$root_dir/cicd-watchdog.cjs"
  "$root_dir/multica-cicd-worker.cjs"
  "$root_dir/multica-archiver.cjs"
  "$root_dir/multica-daemon-wrapper.sh"
  "$root_dir/scoping-claude-driver.sh"
)

declare -a targets=(
  "$runtime_root/gsp-multica-bridge/multica-bridge.cjs"
  "$runtime_root/multica-relay-advance/app/multica-bridge.cjs"
  "$runtime_root/gsp-multica-bridge/guardrails.cjs"
  "$runtime_root/multica-relay-advance/app/guardrails.cjs"
  "$runtime_root/gsp-multica-bridge/parked-diagnosis.cjs"
  "$runtime_root/multica-relay-advance/app/parked-diagnosis.cjs"
  "$runtime_root/gsp-multica-bridge/parked-entry-audit.cjs"
  "$runtime_root/multica-relay-advance/app/parked-entry-audit.cjs"
  "$runtime_root/gsp-multica-bridge/qc-lane.cjs"
  "$runtime_root/multica-relay-advance/app/qc-lane.cjs"
  "$runtime_root/gsp-multica-bridge/qc-strict-evidence.cjs"
  "$runtime_root/multica-relay-advance/app/qc-strict-evidence.cjs"
  "$runtime_root/gsp-multica-bridge/qc-verdict-policy.cjs"
  "$runtime_root/multica-relay-advance/app/qc-verdict-policy.cjs"
  "$runtime_root/gsp-multica-bridge/relay-completion-admission.cjs"
  "$runtime_root/multica-relay-advance/app/relay-completion-admission.cjs"
  "$runtime_root/gsp-multica-bridge/stage-routing.json"
  "$runtime_root/multica-relay-advance/app/stage-routing.json"
  "$runtime_root/gsp-multica-bridge/transition-policy.cjs"
  "$runtime_root/multica-relay-advance/app/transition-policy.cjs"
  "$runtime_root/multica-cicd-worker/transition-policy.cjs"
  "$runtime_root/multica-relay-advance/app/qc-escalate.cjs"
  "$runtime_root/multica-relay-advance/app/qc-gate.cjs"
  "$runtime_root/multica-relay-advance/app/reconciler.cjs"
  "$runtime_root/multica-relay-advance/app/stage-outcome.cjs"
  "$runtime_root/multica-relay-advance/app/stage-routing.cjs"
  "$runtime_root/multica-relay-advance/app/parity/multica-relay-advance-daemon.cjs"
  "$runtime_root/multica-relay-advance/app/parity/relay-dead-rows.cjs"
  "$runtime_root/multica-cicd-worker/cicd-watchdog.cjs"
  "$runtime_root/multica-cicd-worker/multica-cicd-worker.cjs"
  "$runtime_root/multica-archiver/multica-archiver.cjs"
  "$runtime_root/gsp-multica-worker/multica-daemon-wrapper.sh"
  "$runtime_root/gsp-multica-worker/scoping-claude-driver.sh"
)
