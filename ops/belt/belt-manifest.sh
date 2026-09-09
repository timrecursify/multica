#!/usr/bin/env bash
# shellcheck disable=SC2034 # Public arrays are consumed by scripts that source this file.
# Canonical belt release manifest: the one list of what ships where.
#
# deploy.sh, verify.sh and deploy.test.sh all source this file. Three separate
# copies of these arrays drifted apart and shipped a deploy that targeted a tree
# which did not exist on gsp (GSP-2327); keep them here or the drift returns.
#
# Callers must set:
#   root_dir      absolute path of this ops/belt directory
#   runtime_root  deployment root (production: /opt/gsp/multica-workers)
# Optional:
#   BELT_DEPLOY_DOCTRINE_ROOT (production: /opt/gsp/multica-doctrine)
#
# Sourceable runtime interface (all arrays are index-aligned):
#   belt_entry_names              stable entry identifier
#   belt_entry_executables        executed belt file
#   belt_entry_required_siblings  space-delimited runtime dependencies
#   belt_entry_binary_artifacts   space-delimited interpreter/selected binaries
#   belt_entry_units              space-delimited consuming *.service units
#   belt_entry_env_schemas        key into belt_env_schemas (names only)
# `belt_manifest_units_for_entry ENTRY` prints unique consuming units, one per
# line. ENTRY may be an entry name, source path, repository-relative source,
# runtime target, required sibling, or binary artifact. This is the supported
# changed-entry -> restart-unit interface for deploy/restart consumers.
#
# Layout is measured from the running box, where the belt services run out of
# /opt/gsp/multica-workers/<service>/. Ten files are deployed to more than one
# service directory; transition-policy.cjs goes to three. Duplicate source rows
# are intentional -- every apply/backup/rollback loop iterates by index.
#
# The wrapper sources belt-concurrency.sh and workspace-root.sh by absolute
# path, so a runtime missing either cannot start at all. They belong here for
# the same reason the wrapper does.
#
# Files under parity/ require their siblings one directory up, so
# github-api-adapter.cjs ships to app/, not app/parity/. deploy.test.sh resolves
# every such require against this list; a target in the wrong directory is a
# MODULE_NOT_FOUND at daemon start, not a deploy error.

doctrine_root="${BELT_DEPLOY_DOCTRINE_ROOT:-${runtime_root%/multica-workers}/multica-doctrine}"
global_bin_root="${BELT_DEPLOY_GLOBAL_BIN_ROOT:-/usr/local/bin}"

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
  "$root_dir/build-admission.cjs"
  "$root_dir/build-admission.cjs"
  "$root_dir/stage-routing.json"
  "$root_dir/stage-routing.json"
  "$root_dir/transition-policy.cjs"
  "$root_dir/transition-policy.cjs"
  "$root_dir/transition-policy.cjs"
  "$root_dir/qc-escalate.cjs"
  "$root_dir/qc-gate.cjs"
  "$root_dir/reconciler.cjs"
  "$root_dir/stage-outcome.cjs"
  "$root_dir/stage-outcome.cjs"
  "$root_dir/stage-routing.cjs"
  "$root_dir/parity/multica-relay-advance-daemon.cjs"
  "$root_dir/github-api-adapter.cjs"
  "$root_dir/github-api-adapter.cjs"
  "$root_dir/github-token.cjs"
  "$root_dir/parity/relay-dead-rows.cjs"
  "$root_dir/stage-routing.cjs"
  "$root_dir/stage-routing.json"
  "$root_dir/cicd-watchdog.cjs"
  "$root_dir/multica-cicd-worker.cjs"
  "$root_dir/multica-archiver.cjs"
  "$root_dir/multica-daemon-wrapper.sh"
  "$root_dir/scoping-claude-driver.sh"
  "$root_dir/belt-concurrency.sh"
  "$root_dir/workspace-root.sh"
  "$root_dir/workspace-gc.sh"
  "$root_dir/gsp-belt-git-credential.sh"
  "$root_dir/multica-bundle.py"
  "$root_dir/RUNBOOK_SPEC_WORKER.md"
  "$root_dir/RUNBOOK_BUILD_WORKER.md"
  "$root_dir/RUNBOOK_QC_WORKER.md"
  "$root_dir/WORKER_COMMON.md"
  "$root_dir/../gsp-belt/relay/multica-relay-advance-wrapper.sh"
  "$root_dir/../gsp-belt/relay/multica-relay-advance-launcher.cjs"
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
  "$runtime_root/gsp-multica-bridge/build-admission.cjs"
  "$runtime_root/multica-relay-advance/app/build-admission.cjs"
  "$runtime_root/gsp-multica-bridge/stage-routing.json"
  "$runtime_root/multica-relay-advance/app/stage-routing.json"
  "$runtime_root/gsp-multica-bridge/transition-policy.cjs"
  "$runtime_root/multica-relay-advance/app/transition-policy.cjs"
  "$runtime_root/multica-cicd-worker/transition-policy.cjs"
  "$runtime_root/multica-relay-advance/app/qc-escalate.cjs"
  "$runtime_root/multica-relay-advance/app/qc-gate.cjs"
  "$runtime_root/multica-relay-advance/app/reconciler.cjs"
  "$runtime_root/gsp-multica-bridge/stage-outcome.cjs"
  "$runtime_root/multica-relay-advance/app/stage-outcome.cjs"
  "$runtime_root/multica-relay-advance/app/stage-routing.cjs"
  "$runtime_root/multica-relay-advance/app/parity/multica-relay-advance-daemon.cjs"
  "$runtime_root/multica-relay-advance/app/github-api-adapter.cjs"
  "$runtime_root/multica-cicd-worker/github-api-adapter.cjs"
  "$runtime_root/multica-cicd-worker/github-token.cjs"
  "$runtime_root/multica-relay-advance/app/parity/relay-dead-rows.cjs"
  "$runtime_root/multica-cicd-worker/stage-routing.cjs"
  "$runtime_root/multica-cicd-worker/stage-routing.json"
  "$runtime_root/multica-cicd-worker/cicd-watchdog.cjs"
  "$runtime_root/multica-cicd-worker/multica-cicd-worker.cjs"
  "$runtime_root/multica-archiver/multica-archiver.cjs"
  "$runtime_root/gsp-multica-worker/multica-daemon-wrapper.sh"
  "$runtime_root/gsp-multica-worker/scoping-claude-driver.sh"
  "$runtime_root/gsp-multica-worker/belt-concurrency.sh"
  "$runtime_root/gsp-multica-worker/workspace-root.sh"
  "$runtime_root/gsp-multica-worker/workspace-gc.sh"
  "$global_bin_root/gsp-belt-git-credential"
  "$doctrine_root/multica-bundle.py"
  "$doctrine_root/RUNBOOK_SPEC_WORKER.md"
  "$doctrine_root/RUNBOOK_BUILD_WORKER.md"
  "$doctrine_root/RUNBOOK_QC_WORKER.md"
  "$doctrine_root/WORKER_COMMON.md"
  "$runtime_root/multica-relay-advance/multica-relay-advance-wrapper.sh"
  "$runtime_root/multica-relay-advance/app/parity/multica-relay-advance-launcher.cjs"
)

declare -A belt_env_schemas=(
  [relay]="DATABASE_URL GITHUB_RATE_LIMIT_STATE_FILE GSP_BELT_GIT_CREDENTIAL GSP_WORKSPACE_ID MULTICA_ADVANCED_STALL_TTL_MINUTES MULTICA_FAILED_TTL_MINUTES MULTICA_MODEL MULTICA_PROVIDER MULTICA_QUEUED_TASK_TTL_MINUTES QC_ESCALATE_ENABLED QC_ESCALATE_MODEL QC_ESCALATION_BOUNCES QC_ESCALATION_MODELS QC_GATE_CI_ADVISORY QC_GATE_ENABLED QC_GATE_FAIL_OPEN QC_GATE_GH_COOLDOWN_MS QC_GATE_PENDING_RECHECK_MS QC_LANE_EFFORT QC_LANE_MODELS RECONCILE_COMPLETED_STAGE_COOLDOWN_MINUTES RECONCILE_DEFAULT_MAX_ATTEMPTS RECONCILE_DISPATCH_HOLD RECONCILE_HUMAN_REVIEW_ROUTING RECONCILE_ISSUE_COOLDOWN_MINUTES RECONCILE_LIFETIME_TASK_LIMIT RECONCILE_MAX_CREATE_PER_AGENT RECONCILE_MAX_CREATE_PER_CYCLE RECONCILE_MAX_HUMAN_REVIEW_PER_CYCLE RECONCILE_QUOTA_BREAKER_MINUTES RECONCILE_SKIP_STAGES RECONCILE_TYPED_OUTCOMES RELAY_AGENT_SECRET RELAY_LIFETIME_TASK_LIMIT RELAY_MAX_CONCURRENT RELAY_PG_POOL_MAX RELAY_QUOTA_FAILURE_LIMIT RELAY_REQUEUE_BATCH RELAY_REQUEUE_STAGES RELAY_STAGE_CYCLE_LIMIT SPEC_LANE_MODELS"
  [bridge]="ARCHIVER_AGENT_SECRET BUILD_LANE_MODELS DATABASE_URL JWT_SECRET MULTICA_WORKSPACE_ID PORT QC_ESCALATION_BOUNCES QC_ESCALATION_MODELS QC_LANE_EFFORT QC_LANE_MODELS RELAY_AGENT_SECRET RELAY_LIFETIME_TASK_LIMIT RELAY_OPERATOR_SECRET RELAY_RETRY_ESCALATION_DEADLINE_MINUTES RELAY_STAGE_CYCLE_LIMIT SPEC_LANE_MODELS"
  [cicd]="CICD_ABSENT_MINUTES CICD_DEPLOY_CANCEL_RETRY_LIMIT CICD_DEPLOY_TRIGGER_GRACE_MINUTES CICD_FAILURE_POLLS CICD_MERGE_ENABLED CICD_POLL_MS CICD_RETROACTIVE_REPOS CICD_RETRY_BASE_MS CICD_RETRY_LIMIT CICD_SENTINEL_MS CICD_WATCHDOG_STATE DATABASE_URL GH_APP_ENV GSP_BELT_GIT_CREDENTIAL MULTICA_MODEL MULTICA_PROVIDER MULTICA_RECEIPT_ROOT MULTICA_REMOTE_BRIDGE_ENV RELAY_AGENT_SECRET SK_COMMAND"
  [archiver]="ARCHIVER_AGENT_SECRET DATABASE_URL"
  [worker]="CLAUDE_CODE_OAUTH_TOKEN CODEX_BIN CODEX_HOME GH_APP_ENV HOME LOG_LEVEL MULTICA_AGENT_RUNTIME_NAME MULTICA_ALLOW_PAID_LANE MULTICA_CLAUDE_ARGS MULTICA_CLAUDE_MODEL MULTICA_CLAUDE_PATH MULTICA_CODEX_PATH MULTICA_DAEMON_ALLOWED_PROVIDERS MULTICA_DAEMON_BIN MULTICA_DAEMON_CWD MULTICA_DAEMON_DEVICE_NAME MULTICA_DAEMON_ENV_FILE MULTICA_DAEMON_HEARTBEAT_INTERVAL MULTICA_DAEMON_HELP_TIMEOUT_SECONDS MULTICA_DAEMON_ID MULTICA_DAEMON_LOCK_FILE MULTICA_DAEMON_MAX_CONCURRENT_TASKS MULTICA_DAEMON_POLL_INTERVAL MULTICA_DAEMON_PORT MULTICA_DAEMON_PROFILE MULTICA_DAEMON_WORKSPACES_ROOT MULTICA_HEALTH_PORT MULTICA_MODEL MULTICA_PROVIDER MULTICA_SCOPING_DRIVER MULTICA_SCOPING_DRIVER_LOG MULTICA_SERVER_URL MULTICA_TOKEN MULTICA_WORKSPACE_ID MULTICA_WORKSPACES_ROOT PATH SCOPING_DRIVER_POLL_SECONDS"
  [workspace_gc]="BELT_WORKSPACES_ROOT_OVERRIDE BELT_WORKSPACE_UUIDS KEEP_WORKDIR WORKSPACE_GC_BATCH_LIMIT WORKSPACE_GC_DESCRIPTOR_FILE"
)

declare -a belt_entry_names=()
declare -a belt_entry_executables=()
declare -a belt_entry_required_siblings=()
declare -a belt_entry_binary_artifacts=()
declare -a belt_entry_units=()
declare -a belt_entry_env_schemas=()

belt_manifest_add_entry() {
  local name="$1" executable="$2" siblings="$3" binary="$4" units="$5" schema="$6"
  belt_entry_names+=("$name")
  belt_entry_executables+=("$executable")
  belt_entry_required_siblings+=("$siblings")
  belt_entry_binary_artifacts+=("$binary")
  belt_entry_units+=("$units")
  belt_entry_env_schemas+=("$schema")
}

relay_root="$runtime_root/multica-relay-advance"
relay_app="$relay_root/app"
worker_root="$runtime_root/gsp-multica-worker"
bridge_root="$runtime_root/gsp-multica-bridge"
cicd_root="$runtime_root/multica-cicd-worker"
archiver_root="$runtime_root/multica-archiver"

belt_manifest_siblings_below() {
  local prefix="$1" excluded="$2" target excluded_target contains siblings=""
  for target in "${targets[@]}"; do
    [[ "$target" == "$prefix"* ]] || continue
    contains=0
    for excluded_target in $excluded; do [[ "$target" == "$excluded_target" ]] && contains=1; done
    (( contains )) && continue
    siblings+="${siblings:+ }$target"
  done
  printf '%s\n' "$siblings"
}

relay_daemon_siblings="$(belt_manifest_siblings_below "$relay_app/" \
  "$relay_app/parity/multica-relay-advance-daemon.cjs $relay_app/parity/multica-relay-advance-launcher.cjs")"
bridge_siblings="$(belt_manifest_siblings_below "$bridge_root/" "$bridge_root/multica-bridge.cjs")"

belt_manifest_add_entry relay-wrapper \
  "$relay_root/multica-relay-advance-wrapper.sh" \
  "$relay_app/parity/multica-relay-advance-launcher.cjs" \
  /bin/bash multica-relay-advance.service relay
belt_manifest_add_entry relay-launcher \
  "$relay_app/parity/multica-relay-advance-launcher.cjs" \
  "$relay_app/parity/multica-relay-advance-daemon.cjs" \
  /usr/bin/node multica-relay-advance.service relay
belt_manifest_add_entry relay-daemon \
  "$relay_app/parity/multica-relay-advance-daemon.cjs" \
  "$relay_daemon_siblings" \
  /usr/bin/node multica-relay-advance.service relay
belt_manifest_add_entry worker-wrapper \
  "$worker_root/multica-daemon-wrapper.sh" \
  "$worker_root/scoping-claude-driver.sh $worker_root/belt-concurrency.sh $worker_root/workspace-root.sh $doctrine_root/multica-bundle.py $doctrine_root/RUNBOOK_SPEC_WORKER.md $doctrine_root/RUNBOOK_BUILD_WORKER.md $doctrine_root/RUNBOOK_QC_WORKER.md $doctrine_root/WORKER_COMMON.md" \
  "/bin/bash $worker_root/server" \
  "gsp-multica-worker.service gsp-multica-worker-ppp.service" worker
belt_manifest_add_entry cicd-worker \
  "$cicd_root/multica-cicd-worker.cjs" \
  "$cicd_root/transition-policy.cjs $cicd_root/cicd-watchdog.cjs $cicd_root/github-token.cjs" \
  /usr/bin/node multica-cicd-worker.service cicd
belt_manifest_add_entry archiver \
  "$archiver_root/multica-archiver.cjs" "" \
  /usr/bin/node multica-archiver.service archiver
belt_manifest_add_entry bridge \
  "$bridge_root/multica-bridge.cjs" \
  "$bridge_siblings" \
  /usr/bin/node gsp-multica-bridge.service bridge
belt_manifest_add_entry workspace-gc \
  "$worker_root/workspace-gc.sh" "$worker_root/workspace-root.sh" \
  /bin/bash gsp-belt-workspace-gc.service workspace_gc

declare -a belt_units=(
  multica-relay-advance.service
  gsp-multica-worker.service
  gsp-multica-worker-ppp.service
  multica-cicd-worker.service
  multica-archiver.service
  gsp-multica-bridge.service
)
declare -a belt_known_units=("${belt_units[@]}" gsp-belt-workspace-gc.service)

belt_manifest_source_rel() {
  local source="$1"
  case "$source" in
    "$root_dir/../gsp-belt"/*) printf 'ops/gsp-belt/%s\n' "${source#"$root_dir/../gsp-belt/"}" ;;
    "$root_dir"/*) printf 'ops/belt/%s\n' "${source#"$root_dir/"}" ;;
    *) return 1 ;;
  esac
}

belt_manifest_units_for_entry() {
  local query="$1" source_rel candidate index unit matched
  local -a candidates=("$query")
  local -A seen=()
  for index in "${!sources[@]}"; do
    source_rel="$(belt_manifest_source_rel "${sources[$index]}")" || continue
    if [[ "$query" == "${sources[$index]}" || "$query" == "$source_rel" || "$query" == "${targets[$index]}" ]]; then
      candidates+=("${targets[$index]}")
    fi
  done
  for index in "${!belt_entry_names[@]}"; do
    matched=0
    for candidate in "${candidates[@]}"; do
      if [[ "$candidate" == "${belt_entry_names[$index]}" ||
            "$candidate" == "${belt_entry_executables[$index]}" ||
            " ${belt_entry_binary_artifacts[$index]} " == *" $candidate "* ||
            " ${belt_entry_required_siblings[$index]} " == *" $candidate "* ]]; then
        matched=1
        break
      fi
    done
    (( matched )) || continue
    for unit in ${belt_entry_units[$index]}; do
      [[ -n "${seen[$unit]-}" ]] && continue
      seen[$unit]=1
      printf '%s\n' "$unit"
    done
  done
}
