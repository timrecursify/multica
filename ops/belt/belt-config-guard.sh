#!/usr/bin/env bash
# shellcheck disable=SC1091
# Belt config guard.
# shellcheck disable=SC2016 # Literal shell fragments are checked below.
# shellcheck disable=SC2009 # The full command line is required for flag validation.
#
# Doctrine (Tim, 2026-08-30): sentinel fixes what code can fix and files a P0
# ticket for what it cannot. It never raises an alert for a human to action.
# Level 4 autonomy: this script repairs drift on its own.
#
# Config on this box has been silently reverted by concurrent desks, so every
# setting below is re-asserted on a schedule rather than trusted once.
set -uo pipefail

readonly PM2=/home/newadmin/.npm-global/bin/pm2
readonly SK=/home/newadmin/bin/sk
readonly GSP_WS='f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f'
readonly RELAY_ENV_FILE="${BELT_RELAY_ENV_FILE:-/home/newadmin/gsp-multica/.env}"
readonly RELAY_HEALTH_URL="${BELT_RELAY_HEALTH_URL:-}"
readonly WRAPPER=/home/newadmin/gsp-multica/fleet/multica-daemon-wrapper.sh
readonly SOURCE_ROOT="${BELT_SOURCE_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)}"
readonly GUARD_SOURCE="${BELT_SOURCE_GUARD:-${SOURCE_ROOT}/belt-config-guard.sh}"
readonly WRAPPER_SOURCE="${BELT_SOURCE_WRAPPER:-${SOURCE_ROOT}/multica-daemon-wrapper.sh}"
readonly RUNTIME_ROOT="${BELT_RUNTIME_ROOT:-/home/newadmin}"
readonly RUNTIME_GUARD="${RUNTIME_ROOT}/tools/belt-config-guard.sh"
readonly RUNTIME_WRAPPER="${RUNTIME_ROOT}/gsp-multica/fleet/multica-daemon-wrapper.sh"
readonly RELEASE_ROOT="${BELT_RELEASE_ROOT:-/home/newadmin/gsp-multica-runtime/releases}"
readonly ECOSYSTEM=/home/newadmin/gsp-multica/fleet/ecosystem.gsp-belt.config.js
# Keep release identity validation aligned with deploy-release.sh.  The
# metadata digest is meaningful only when it covers the complete runtime
# manifest, including both members of the parity pair.
readonly RELEASE_MANIFEST=(
  ops/belt/multica-bridge.cjs ops/belt/guardrails.cjs
  ops/belt/parked-diagnosis.cjs ops/belt/parked-entry-audit.cjs
  ops/belt/parity/multica-relay-advance-daemon.cjs
  ops/belt/parity/relay-dead-rows.cjs ops/belt/multica-cicd-worker.cjs
  ops/belt/cicd-watchdog.cjs ops/belt/cicd-deploy-evidence.cjs
  ops/belt/multica-archiver.cjs ops/belt/reconciler.cjs
  ops/belt/stage-outcome.cjs ops/belt/transition-policy.cjs
  ops/belt/stage-routing.cjs ops/belt/qc-strict-evidence.cjs
  ops/belt/qc-verdict-policy.cjs ops/belt/belt-config-guard.sh
  ops/belt/multica-daemon-wrapper.sh ops/belt/ecosystem.gsp-belt.config.js
  ops/belt/workspace-root.sh
  ops/belt/multica-bundle.py ops/belt/RUNBOOK_SPEC_WORKER.md
  ops/belt/RUNBOOK_BUILD_WORKER.md ops/belt/RUNBOOK_QC_WORKER.md
  ops/belt/WORKER_COMMON.md ops/belt/relay-completion-admission.cjs
)
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/belt-concurrency.sh"
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/workspace-root.sh"
WANT_CONCURRENCY="$(belt_resolve_concurrency)"
readonly WANT_CONCURRENCY
readonly WANT_WORKSPACES_ROOT="$BELT_CANONICAL_WORKSPACES_ROOT"
readonly BUILD_AGENT=gsp-build-deepseek-flash-1
# 2026-08-31 14:20 UTC: global 12 -> 20, build capacity 3 -> 15, QC 4 each.
# Tim's directive: 12-15 build employees, 3-4 QC.
# Build is the only bottleneck. Measured over 55 completed builds in 6h from
# started_at -> completed_at: build median 18.3 min, mean 27.6 min; QC 1-3 min.
# At build cap 3 the lane held 147 queued and expired 141 paid attempts as
# queued_expired without ever running them.
# Raising build alone does nothing: per-agent caps are not additive against the
# Tower's global cap (multica-relay-advance-daemon.cjs:329-337), so the global
# rises with it. This is the material difference from the 09:20 experiment
# below, which only reapportioned a fixed 12.
#
# PRIOR FAILURE THIS MUST NOT REPEAT (09:20 UTC, global fixed at 12):
# moving build 3 -> 6 took slots from a 30/hr lane to feed a 1.7/hr one and
# pushed the scoper's queue wait past the task TTL, so tickets expired and
# re-dispatched in a loop:
#   01:00-07:00  multica-qc-worker-2  ~50 completed/hour, ZERO queued_expired
#   08:00 (after the split)           46 completed, 74 queued_expired
#   09:00                              5 completed,  9 queued_expired
# Here build 15 of 20 leaves QC 5 slots against a measured historical need of
# ~138/hr; 5 slots at 1-3 min/task carry ~100-300/hr.
# TRIPWIRE: if queued_expired reappears on any multica-qc-worker-*, or QC
# completions/hour fall below ~100, this is the same failure -- revert first.
# Churn is not permanent stranding: the relay daemon lists queued_expired in
# INFRA_FAILURE_REASONS, so a requeue costs no retry budget.
# Risk accepted: 15 concurrent builds on a 12-core box is CPU-oversubscribed;
# builds are mostly OpenRouter-API-bound, so local cost is checkout plus tests.
# Revert: WANT_BUILD_CAPACITY=3, WANT_CONCURRENCY=12, restore
# belt-config-guard.sh.pre-buildlane-20260831. Tracked on GSP-800.
# 12, not 15, since 2026-08-31. The Tower's global cap of 20 is the only binding
# limit, so a build cap of 15 does not buy 15 builds -- it takes slots from the
# scoper, which is the lane that gates every stage downstream. Measured at the
# change: build cap 15 / running 10 / queued 28, against scoper cap 4 / running
# 4 / queued 177. Host CPU was 0.1% idle with 8 CI jobs, so raising the global
# cap was not available; this is reallocation inside a fixed 20. 12 is the floor
# Tim set for the build lane and must not go lower.
readonly WANT_BUILD_CAPACITY=12
readonly WANT_RELAY_STAGE_CYCLE_LIMIT=2
readonly WANT_RELAY_LIFETIME_TASK_LIMIT=6
readonly GUARDED_APPS=(gsp-multica-bridge multica-cicd-worker multica-archiver gsp-multica-worker)
# These are enforced from the deployed PM2 environment, not merely mirrored
# from relay defaults. Both relay owners must share the same bounded budgets.
readonly RELAY_CAP_EXPECTATIONS=(
  "gsp-multica-bridge|${WANT_RELAY_STAGE_CYCLE_LIMIT}|${WANT_RELAY_LIFETIME_TASK_LIMIT}"
  "multica-relay-advance|${WANT_RELAY_STAGE_CYCLE_LIMIT}|${WANT_RELAY_LIFETIME_TASK_LIMIT}"
)
# Apps that must be RUNNING, checked by status rather than by guardrails.
# multica-relay-advance is here but NOT in GUARDED_APPS: it is not defined in
# ECOSYSTEM, so it is restarted by name and cannot be started via --only.
readonly LIVENESS_APPS=(gsp-multica-bridge multica-cicd-worker multica-archiver gsp-multica-worker multica-relay-advance)
# Operators may intentionally hold the AI worker while investigating spend or
# deploying guardrails.  This marker suppresses only worker self-healing; all
# pipeline services remain under the normal liveness guard.
readonly AI_HOLD_FILE="${MULTICA_AI_HOLD_FILE:-/home/newadmin/.local/state/multica-ai-hold}"
readonly PSQL=(docker exec -i gsp-multica-v2-postgres-1 psql -U gsp_multica -d gsp_multica -At)

fixed=(); unfixable=()
RELAY_PREFLIGHT_OK=1
RELAY_PREFLIGHT_DIAGNOSTIC=''
PARITY_OK=1
PARITY_DIAGNOSTIC=''

repair_failure() {
  local diagnostic="$1"
  PARITY_OK=0
  PARITY_DIAGNOSTIC="$diagnostic"
  unfixable+=("belt runtime/source parity repair failed: ${diagnostic}")
}

release_manifest_checksum() {
  local release="$1" file
  for file in "${RELEASE_MANIFEST[@]}"; do
    [[ -f "$release/$file" ]] || return 1
  done
  (cd -- "$release" && sha256sum "${RELEASE_MANIFEST[@]}" | sha256sum | awk '{print $1}')
}

# A deployed guard can live outside the source tree, so recover the paired
# wrapper from a complete release when the source wrapper is not installed.
validated_release_wrapper() {
  local guard_sha="$1" candidate_guard release candidate_wrapper metadata source_sha manifest_sha256
  [[ -d "$RELEASE_ROOT" && ! -L "$RELEASE_ROOT" ]] || return 1
  while IFS= read -r candidate_guard; do
    release="${candidate_guard%/ops/belt/belt-config-guard.sh}"
    candidate_wrapper="$release/ops/belt/multica-daemon-wrapper.sh"
    [[ -d "$release" && ! -L "$release" && -r "$candidate_wrapper" ]] || continue
    # A release is identified by its immutable commit directory.  Merely
    # finding two matching blobs is insufficient: a copied/misnamed release
    # could otherwise supply an unreviewed wrapper.
    [[ "$(basename -- "$release")" =~ ^[0-9a-f]{40}$ ]] || continue
    [[ "$(sha256sum -- "$candidate_guard" 2>/dev/null | awk '{print $1}')" == "$guard_sha" ]] || continue
    metadata="$release/.gsp-belt-release.json"
    [[ -r "$metadata" ]] || continue
    source_sha=$(sed -n 's/.*"source_sha"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F]\{40\}\)".*/\1/p' "$metadata" | head -1)
    manifest_sha256=$(sed -n 's/.*"manifest_sha256"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F]\{64\}\)".*/\1/p' "$metadata" | head -1)
    [[ "$source_sha" =~ ^[0-9a-fA-F]{40}$ && "$manifest_sha256" =~ ^[0-9a-fA-F]{64}$ &&
       "${source_sha,,}" == "$(basename -- "$release")" &&
       "$manifest_sha256" == "$(release_manifest_checksum "$release")" ]] || continue
    printf '%s\n' "$candidate_wrapper"
    return 0
  done < <(printf '%s\n' "$RELEASE_ROOT"/*/ops/belt/belt-config-guard.sh 2>/dev/null)
  return 1
}

# Resolve an authenticated release containing the complete parity pair.  The
# caller may provide either expected digest (or an empty value when that
# source member is absent); metadata and the complete manifest remain
# mandatory, so a lone copied blob can never become an authority.
validated_release_pair() {
  local expected_guard_sha="${1:-}" expected_wrapper_sha="${2:-}"
  local candidate_guard release candidate_wrapper metadata source_sha manifest_sha256
  [[ -d "$RELEASE_ROOT" && ! -L "$RELEASE_ROOT" ]] || return 1
  while IFS= read -r candidate_guard; do
    release="${candidate_guard%/ops/belt/belt-config-guard.sh}"
    candidate_wrapper="$release/ops/belt/multica-daemon-wrapper.sh"
    [[ -d "$release" && ! -L "$release" && -r "$candidate_guard" && -r "$candidate_wrapper" ]] || continue
    [[ "$(basename -- "$release")" =~ ^[0-9a-f]{40}$ ]] || continue
    [[ -x "$candidate_guard" && -x "$candidate_wrapper" ]] || continue
    [[ -z "$expected_guard_sha" || "$(sha256sum -- "$candidate_guard" | awk '{print $1}')" == "$expected_guard_sha" ]] || continue
    [[ -z "$expected_wrapper_sha" || "$(sha256sum -- "$candidate_wrapper" | awk '{print $1}')" == "$expected_wrapper_sha" ]] || continue
    metadata="$release/.gsp-belt-release.json"
    [[ -r "$metadata" ]] || continue
    source_sha=$(sed -n 's/.*"source_sha"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F]\{40\}\)".*/\1/p' "$metadata" | head -1)
    manifest_sha256=$(sed -n 's/.*"manifest_sha256"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F]\{64\}\)".*/\1/p' "$metadata" | head -1)
    [[ "$source_sha" =~ ^[0-9a-fA-F]{40}$ && "$manifest_sha256" =~ ^[0-9a-fA-F]{64}$ &&
       "${source_sha,,}" == "$(basename -- "$release")" &&
       "$manifest_sha256" == "$(release_manifest_checksum "$release")" ]] || continue
    printf '%s\n' "$release"
    return 0
  done < <(printf '%s\n' "$RELEASE_ROOT"/*/ops/belt/belt-config-guard.sh 2>/dev/null)
  return 1
}

# Recover a missing member of the guard/wrapper pair only from a complete,
# immutable release that contains the exact source blobs.  Validation happens
# before either destination is touched; installation is protected by a lock
# and rolls back if the second rename fails.
repair_source_runtime_parity() {
  local guard_sha wrapper_sha release candidate_guard candidate_wrapper lock staging old_guard old_wrapper metadata source_sha manifest_sha256 wrapper_source guard_source
  local guard_present=0 wrapper_present=0 needs_repair=0
  guard_source="$GUARD_SOURCE"
  guard_sha=$(sha256sum -- "$guard_source" 2>/dev/null | awk '{print $1}')
  wrapper_source="$WRAPPER_SOURCE"
  wrapper_sha=$(sha256sum -- "$wrapper_source" 2>/dev/null | awk '{print $1}')
  if [[ ! "$guard_sha" =~ ^[0-9a-f]{64}$ || ! "$wrapper_sha" =~ ^[0-9a-f]{64}$ ]]; then
    release=$(validated_release_pair "$guard_sha" "$wrapper_sha" 2>/dev/null || true)
    if [[ -n "$release" ]]; then
      guard_source="$release/ops/belt/belt-config-guard.sh"
      wrapper_source="$release/ops/belt/multica-daemon-wrapper.sh"
      guard_sha=$(sha256sum -- "$guard_source" | awk '{print $1}')
      wrapper_sha=$(sha256sum -- "$wrapper_source" | awk '{print $1}')
    fi
  fi
  if [[ ! "$guard_sha" =~ ^[0-9a-f]{64}$ || ! "$wrapper_sha" =~ ^[0-9a-f]{64}$ ]]; then
    repair_failure 'phase=repair missing=source-pair'
    return 0
  fi
  if [[ -r "$RUNTIME_GUARD" ]]; then
    guard_present=1
    [[ "$(sha256sum -- "$RUNTIME_GUARD" | awk '{print $1}')" == "$guard_sha" ]] || needs_repair=1
  else
    needs_repair=1
  fi
  if [[ -r "$RUNTIME_WRAPPER" ]]; then
    wrapper_present=1
    [[ "$(sha256sum -- "$RUNTIME_WRAPPER" | awk '{print $1}')" == "$wrapper_sha" ]] || needs_repair=1
  else
    needs_repair=1
  fi
  (( needs_repair )) || return 0
  [[ -d "$RELEASE_ROOT" && ! -L "$RELEASE_ROOT" ]] || {
    repair_failure 'phase=repair incomplete-release=release-root'
    return 0
  }
  release=''
  while IFS= read -r candidate_guard; do
    release="${candidate_guard%/ops/belt/belt-config-guard.sh}"
    [[ -d "$release" && ! -L "$release" ]] || { release=''; continue; }
    [[ "$(basename -- "$release")" =~ ^[0-9a-f]{40}$ ]] || { release=''; continue; }
    candidate_wrapper="$release/ops/belt/multica-daemon-wrapper.sh"
    [[ -r "$candidate_wrapper" ]] || { release=''; continue; }
    [[ "$(sha256sum -- "$candidate_guard" | awk '{print $1}')" == "$guard_sha" ]] || { release=''; continue; }
    [[ "$(sha256sum -- "$candidate_wrapper" | awk '{print $1}')" == "$wrapper_sha" ]] || { release=''; continue; }
    metadata="$release/.gsp-belt-release.json"
    [[ -r "$metadata" ]] || { release=''; continue; }
    source_sha=$(sed -n 's/.*"source_sha"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F]\{40\}\)".*/\1/p' "$metadata" | head -1)
    manifest_sha256=$(sed -n 's/.*"manifest_sha256"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F]\{64\}\)".*/\1/p' "$metadata" | head -1)
    [[ "$source_sha" =~ ^[0-9a-fA-F]{40}$ && "$manifest_sha256" =~ ^[0-9a-fA-F]{64}$ &&
       "${source_sha,,}" == "$(basename -- "$release")" &&
       "$manifest_sha256" == "$(release_manifest_checksum "$release")" ]] || { release=''; continue; }
    break
  done < <(printf '%s\n' "$RELEASE_ROOT"/*/ops/belt/belt-config-guard.sh 2>/dev/null)
  [[ -n "$release" ]] || {
    repair_failure 'phase=repair incomplete-release=matching-blobs-or-ref'
    return 0
  }
  if ! mkdir -p -- "$(dirname -- "$RUNTIME_GUARD")" "$(dirname -- "$RUNTIME_WRAPPER")"; then
    repair_failure 'phase=repair class=permission mkdir-failed'
    return 0
  fi
  lock="${RUNTIME_ROOT}/.belt-config-parity.lock"
  if ! exec 8>"$lock" || ! flock -n 8; then
    repair_failure 'phase=repair class=permission lock-failed'
    return 0
  fi
  staging="$(mktemp -d "${RUNTIME_ROOT}/.belt-config-parity.XXXXXX")" || {
    repair_failure 'phase=repair class=permission staging-failed'
    return 0
  }
  old_guard="$staging/old-guard"; old_wrapper="$staging/old-wrapper"
  if ! cp -- "$release/ops/belt/belt-config-guard.sh" "$staging/guard" ||
     ! cp -- "$release/ops/belt/multica-daemon-wrapper.sh" "$staging/wrapper" ||
     [[ "$(sha256sum -- "$staging/guard" | awk '{print $1}')" != "$guard_sha" ]] ||
     [[ "$(sha256sum -- "$staging/wrapper" | awk '{print $1}')" != "$wrapper_sha" ]]; then
    rm -rf -- "$staging"
    repair_failure 'phase=repair class=permission staging-copy-failed'
    return 0
  fi
  [[ "$guard_present" == 1 ]] && cp -- "$RUNTIME_GUARD" "$old_guard"
  [[ "$wrapper_present" == 1 ]] && cp -- "$RUNTIME_WRAPPER" "$old_wrapper"
  if ! mv -f -- "$staging/guard" "$RUNTIME_GUARD" || ! mv -f -- "$staging/wrapper" "$RUNTIME_WRAPPER"; then
    if [[ "$guard_present" == 1 ]]; then cp -- "$old_guard" "$RUNTIME_GUARD"; else rm -f -- "$RUNTIME_GUARD"; fi
    if [[ "$wrapper_present" == 1 ]]; then cp -- "$old_wrapper" "$RUNTIME_WRAPPER"; else rm -f -- "$RUNTIME_WRAPPER"; fi
    rm -rf -- "$staging"
    repair_failure 'phase=repair class=permission atomic-rename-failed'
    return 0
  fi
  rm -rf -- "$staging"
  chmod 0755 -- "$RUNTIME_GUARD" "$RUNTIME_WRAPPER" 2>/dev/null || true
  fixed+=("belt runtime/source parity repaired from release")
}

# The guard and its daemon wrapper are deployed as a pair.  A stale runtime
# copy can execute an obsolete direct-status recovery path, so fail closed
# before any relay transition when either digest differs.  Paths are fixed to
# the source tree and the two expected runtime locations; no broad filesystem
# search is performed.
guard_source_runtime_parity() {
  local source_file runtime_file source_sha runtime_sha label runtime_dir staging fallback guard_source wrapper_source release
  guard_source="$GUARD_SOURCE"; wrapper_source="$WRAPPER_SOURCE"
  if [[ ! -r "$guard_source" || ! -r "$wrapper_source" ]]; then
    release=$(validated_release_pair "$(sha256sum -- "$guard_source" 2>/dev/null | awk '{print $1}')" "$(sha256sum -- "$wrapper_source" 2>/dev/null | awk '{print $1}')" 2>/dev/null || true)
    if [[ -n "$release" ]]; then
      guard_source="$release/ops/belt/belt-config-guard.sh"
      wrapper_source="$release/ops/belt/multica-daemon-wrapper.sh"
    fi
  fi
  for label in guard wrapper; do
    if [[ "$label" == guard ]]; then
      source_file="$guard_source"; runtime_file="$RUNTIME_GUARD"
    else
      source_file="$wrapper_source"; runtime_file="$RUNTIME_WRAPPER"
    fi
    if [[ ! -r "$source_file" && "$label" == wrapper ]]; then
      fallback=$(validated_release_wrapper "$(sha256sum -- "$GUARD_SOURCE" 2>/dev/null | awk '{print $1}')" 2>/dev/null || true)
      [[ -n "$fallback" ]] && source_file="$fallback"
    fi
    if [[ ! -r "$source_file" ]]; then
      PARITY_OK=0
      PARITY_DIAGNOSTIC="phase=parity ${label}=missing"
      unfixable+=("belt runtime/source digest drift: ${PARITY_DIAGNOSTIC}")
      continue
    fi
    source_sha=$(sha256sum -- "$source_file" 2>/dev/null | awk '{print $1}')
    runtime_sha=$(sha256sum -- "$runtime_file" 2>/dev/null | awk '{print $1}')
    if [[ "$source_sha" =~ ^[0-9a-f]{64}$ && "$source_sha" != "$runtime_sha" ]]; then
      # Runtime copies are disposable deployment artifacts. Repair a missing
      # or stale member directly from the readable source, using a temporary
      # file in the runtime directory so readers never observe a partial copy.
      runtime_dir=$(dirname -- "$runtime_file")
      staging=''
      if mkdir -p -- "$runtime_dir" 2>/dev/null &&
         staging=$(mktemp "${runtime_dir}/.parity.XXXXXX" 2>/dev/null) &&
         cp -- "$source_file" "$staging" 2>/dev/null &&
         chmod 0755 -- "$staging" 2>/dev/null &&
         mv -f -- "$staging" "$runtime_file" 2>/dev/null &&
         runtime_sha=$(sha256sum -- "$runtime_file" 2>/dev/null | awk '{print $1}') &&
         [[ "$runtime_sha" == "$source_sha" ]]; then
        fixed+=("belt runtime/source parity repaired from source")
        continue
      fi
      [[ -z "$staging" ]] || rm -f -- "$staging"
      PARITY_OK=0
      PARITY_DIAGNOSTIC="phase=parity ${label}=digest-mismatch"
      unfixable+=("belt runtime/source digest drift: ${PARITY_DIAGNOSTIC}")
    elif [[ ! "$source_sha" =~ ^[0-9a-f]{64}$ || "$source_sha" != "$runtime_sha" ]]; then
      PARITY_OK=0
      PARITY_DIAGNOSTIC="phase=parity ${label}=digest-mismatch"
      unfixable+=("belt runtime/source digest drift: ${PARITY_DIAGNOSTIC}")
    fi
  done
}

# Status writes are relay-owned.  Check the relay contract before attempting
# any recovery so a missing/invalid secret cannot look like a successful repair.
# Diagnostics deliberately report names and failure phases only; secret values
# and connection strings never enter the guard output or the P0 ticket.
guard_relay_preflight() {
  local missing=() duplicate=() key value agent operator workspace sso database count
  if [[ ! -r "$RELAY_ENV_FILE" ]]; then
    RELAY_PREFLIGHT_OK=0
    RELAY_PREFLIGHT_DIAGNOSTIC="phase=preflight config=unreadable"
    unfixable+=("relay recovery ${RELAY_PREFLIGHT_DIAGNOSTIC}")
    return 0
  fi
  # Keep this list in lockstep with the relay launcher/fleet manifest.  The
  # guard must reject a file that can start the bridge but cannot authenticate
  # the relay daemon, before it attempts any stage mutation.
  for key in DATABASE_URL RELAY_AGENT_SECRET RELAY_OPERATOR_SECRET GSP_WORKSPACE_ID MULTICA_WORKSPACE_ID; do
    count=$(grep -Ec "^[[:space:]]*${key}=" "$RELAY_ENV_FILE" 2>/dev/null || true)
    [[ "$count" == 1 ]] || duplicate+=("$key")
    value=$(sed -n "s/^${key}=//p" "$RELAY_ENV_FILE" | tail -1)
    [[ -n "$value" ]] || missing+=("$key")
  done
  agent=$(sed -n 's/^RELAY_AGENT_SECRET=//p' "$RELAY_ENV_FILE" | tail -1)
  operator=$(sed -n 's/^RELAY_OPERATOR_SECRET=//p' "$RELAY_ENV_FILE" | tail -1)
  workspace=$(sed -n 's/^GSP_WORKSPACE_ID=//p' "$RELAY_ENV_FILE" | tail -1)
  sso=$(sed -n 's/^MULTICA_WORKSPACE_ID=//p' "$RELAY_ENV_FILE" | tail -1)
  database=$(sed -n 's/^DATABASE_URL=//p' "$RELAY_ENV_FILE" | tail -1)
  if (( ${#missing[@]} > 0 )); then
    RELAY_PREFLIGHT_OK=0
    RELAY_PREFLIGHT_DIAGNOSTIC="phase=preflight missing=${missing[*]}"
  elif (( ${#duplicate[@]} > 0 )); then
    RELAY_PREFLIGHT_OK=0
    RELAY_PREFLIGHT_DIAGNOSTIC="phase=preflight duplicate=${duplicate[*]}"
  elif [[ "$agent" == "$operator" || "$agent" =~ [[:space:]] || "$operator" =~ [[:space:]] ||
          "$agent" == CHANGE_ME* || "$operator" == CHANGE_ME* ||
          ! "$workspace" =~ ^[0-9a-fA-F-]{36}$ || "$workspace" != "$GSP_WS" ||
          "$sso" != "$GSP_WS" || ! "$database" =~ ^(postgres|postgresql)://[^[:space:]]+$ ]]; then
    RELAY_PREFLIGHT_OK=0
    RELAY_PREFLIGHT_DIAGNOSTIC='phase=preflight invalid=relay-credentials-workspace-or-database'
  fi
  if (( RELAY_PREFLIGHT_OK == 0 )); then
    unfixable+=("relay recovery ${RELAY_PREFLIGHT_DIAGNOSTIC}")
    return 0
  fi
  # When configured, verify the live bridge before any transition.  The probe
  # is deliberately opt-in for offline fixture runs; production sets the URL
  # in the guard service environment.  Only bounded, redacted fields are
  # accepted from the health endpoint.
  if [[ -n "$RELAY_HEALTH_URL" ]]; then
    local health
    health=$(curl --fail --silent --show-error --max-time 3 \
      -H "X-Relay-Agent-Secret: ${agent}" "$RELAY_HEALTH_URL" 2>&1) || {
      RELAY_PREFLIGHT_OK=0
      RELAY_PREFLIGHT_DIAGNOSTIC='phase=health transport=unavailable'
      unfixable+=("relay recovery ${RELAY_PREFLIGHT_DIAGNOSTIC}")
      return 0
    }
    if ! jq -e --arg ws "$GSP_WS" \
      '(.status == "ok" or .status == "healthy") and (.workspace_id == $ws) and (.authority == "ready")' \
      >/dev/null 2>&1 <<<"$health"; then
      RELAY_PREFLIGHT_OK=0
      RELAY_PREFLIGHT_DIAGNOSTIC='phase=health invalid=workspace-or-authority'
      unfixable+=("relay recovery ${RELAY_PREFLIGHT_DIAGNOSTIC}")
    fi
  fi
}

ai_hold_active() {
  [[ -f "$AI_HOLD_FILE" ]]
}

file_p0() {
  local title="$1" body="$2" out rc
  out=$("$SK" multica create --board gsp --title "P0: $title" --desc "$body" 2>&1); rc=$?
  if [[ $rc -eq 0 ]]; then
    return 0
  fi
  # Equivalent duplicate responses have had several API spellings. They all
  # mean an equivalent open P0 already exists; auth and transport failures do
  # not match and remain actionable errors.
  if [[ "$out" =~ active_duplicate_issue|duplicate_issue|already[[:space:]_-]+exists|canonical_duplicate|equivalent[[:space:]_-]+open ]]; then
    echo "belt-config-guard: P0 already open for: $title" >&2
    return 0
  fi
  echo "belt-config-guard: FAILED to file P0 ticket: $title: ${out//$'\n'/ }" >&2
}

# Re-flying a stranded flight only helps if its new task can actually RUN. The
# queue drops a task after a hard 120-minute TTL (failure_reason
# 'queued_expired'; 514 died that way on 2026-08-31, median wait 120.3 min), and
# the relay's own requeue is already capacity-blocked most ticks
# ("[requeue] HELD: N candidate(s) ... cap=7, running=7"). So when the queue is
# already backed up past half the TTL, adding more work does not recover
# anything: it manufactures fresh expiry victims and inflates the backlog that
# caused the stranding. Gate the re-fly passes on real headroom. The 60 is not a
# chosen number -- it is half the measured TTL, the point past which a newly
# queued task is more likely to expire than to run.
queue_backed_up() {
  local oldest
  oldest=$("${PSQL[@]}" -c "SELECT coalesce(round(max(EXTRACT(epoch FROM (now()-created_at))/60)),0)
                              FROM agent_task_queue WHERE status='queued';" 2>/dev/null </dev/null)
  [[ "$oldest" =~ ^[0-9]+$ ]] || return 1
  (( oldest > 60 ))
}

running_tasks() {
  "${PSQL[@]}" -c "SELECT count(*) FROM agent_task_queue WHERE status='running';" 2>/dev/null || echo 99
}

# 1. Tower concurrency and root must remain PM2-configurable, so the environment
# still wins when it is set. The guard runs from belt-config-guard.service, a
# systemd oneshot with no PM2 environment, so an unset cap must fall back to the
# declared fleet value rather than to the empty string: an empty cap makes
# tower_concurrency_state report "mismatched" against every running Tower and
# restarts gsp-multica-worker on each 5-minute tick. 32 is the fleet cap asserted
# by ops/belt/deploy-daemon-artifact.sh health().
daemon_launch_config() {
  printf '%s|%s\n' "${MULTICA_DAEMON_MAX_CONCURRENT_TASKS-"$WANT_CONCURRENCY"}" \
    "${MULTICA_DAEMON_WORKSPACES_ROOT-"$WANT_WORKSPACES_ROOT"}"
}

validate_daemon_launch_config() {
  local cap root
  IFS='|' read -r cap root < <(daemon_launch_config)
  [[ "$cap" =~ ^[1-9][0-9]*$ ]] && (( cap <= $(belt_cpu_count) )) || return 1
  workspace_root_validate >/dev/null
}

wrapper_has_explicit_concurrency_flag() {
  local wrapper_file="$1"
  # Keep the runtime cap tied to the validated shell variable. A numeric
  # literal would silently drift from the environment on a later restart.
  grep -Fq -- '--max-concurrent-tasks="$cap_raw"' "$wrapper_file" &&
    ! grep -Eq -- '--max-concurrent-tasks="?[0-9]' "$wrapper_file"
}

guard_wrapper() {
  if ! validate_daemon_launch_config; then
    unfixable+=("invalid PM2 daemon launch config: cap must be a positive integer and workspace root must be canonical with valid children")
  elif [[ ! -x "$WRAPPER" ]] ||
       ! grep -q 'MULTICA_DAEMON_MAX_CONCURRENT_TASKS-' "$WRAPPER" ||
       ! grep -q 'MULTICA_DAEMON_WORKSPACES_ROOT-' "$WRAPPER" ||
       ! grep -q 'MULTICA_DAEMON_MAX_CONCURRENT_TASKS' "$ECOSYSTEM" ||
       ! grep -q 'MULTICA_DAEMON_WORKSPACES_ROOT' "$ECOSYSTEM" ||
       ! wrapper_has_explicit_concurrency_flag "$WRAPPER"; then
    unfixable+=("wrapper configuration drifted; expected env-resolved concurrency/root and explicit cap flag in $WRAPPER")
  fi
}

# 1b. The running Tower must match the wrapper. A patched file is not a patched
# process: a restart that happened while the file was drifted leaves a correct
# file and a wrong process, which the file check alone cannot see.
tower_concurrency_state() {
  local live="$1" want_concurrency
  IFS='|' read -r want_concurrency < <(daemon_launch_config)
  if [[ ! "$live" =~ (^|[[:space:]])--max-concurrent-tasks= ]]; then
    printf '%s\n' missing
  elif [[ "$live" =~ (^|[[:space:]])--max-concurrent-tasks=${want_concurrency}([[:space:]]|$) ]]; then
    printf '%s\n' correct
  else
    printf '%s\n' mismatched
  fi
}

guard_tower_process() {
  local live concurrency_state
  if ai_hold_active; then
    unfixable+=("gsp-multica-worker held by ${AI_HOLD_FILE}")
    return 0
  fi
  live=$(ps -eo args | grep "[m]ultica-daemon/server daemon start" | head -1)
  [[ -z "$live" ]] && { unfixable+=("Tower process not found"); return; }
  concurrency_state=$(tower_concurrency_state "$live")
  [[ "$concurrency_state" == correct ]] && return 0
  if (( $(running_tasks) > 0 )); then
    unfixable+=("Tower running concurrency ${concurrency_state}: $live, want ${WANT_CONCURRENCY}; deferred, flights in progress")
    return
  fi
  if "$PM2" startOrRestart "$ECOSYSTEM" --only gsp-multica-worker >/dev/null 2>&1; then
    "$PM2" save >/dev/null 2>&1
    fixed+=("Tower restarted to pick up concurrency ${WANT_CONCURRENCY} (was $live)")
  else
    unfixable+=("could not restart Tower to apply concurrency ${WANT_CONCURRENCY}")
  fi
}

# 2. PM2 restart guardrails must persist, or a crashloop burns fuel unbounded.
guard_pm2() {
  local missing=() app
  for app in "${GUARDED_APPS[@]}"; do
    "$PM2" jlist 2>/dev/null | python3 -c "
import json,sys
a=[x for x in json.load(sys.stdin) if x['name']=='$app']
sys.exit(0 if a and a[0]['pm2_env'].get('max_restarts') else 1)
" || missing+=("$app")
  done
  (( ${#missing[@]} == 0 )) && return 0
  for app in "${missing[@]}"; do
    if [[ "$app" == gsp-multica-worker ]] && ai_hold_active; then
      unfixable+=("$app guardrails missing; held by ${AI_HOLD_FILE}")
      continue
    fi
    # Restarting the Tower kills in-flight flights; only do it when idle.
    if [[ "$app" == gsp-multica-worker ]] && (( $(running_tasks) > 0 )); then
      unfixable+=("$app guardrails missing; deferred, flights in progress")
      continue
    fi
    if "$PM2" startOrRestart "$ECOSYSTEM" --only "$app" >/dev/null 2>&1; then
      fixed+=("pm2 guardrails re-applied to $app")
    else
      unfixable+=("pm2 startOrRestart failed for $app")
    fi
  done
  "$PM2" save >/dev/null 2>&1 || unfixable+=("pm2 save failed; guardrails may not survive a reboot")
}

relay_caps_match() {
  local expected_stage="$1" expected_lifetime="$2" actual_stage="$3" actual_lifetime="$4"
  [[ "$actual_stage" == "$expected_stage" && "$actual_lifetime" == "$expected_lifetime" ]]
}

relay_cap_values() {
  local app="$1"
  "$PM2" jlist 2>/dev/null | python3 -c '
import json,sys
app=sys.argv[1]
try:
    rows=json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
rows=[row for row in rows if row.get("name")==app]
if not rows:
    raise SystemExit(1)
env=rows[0].get("pm2_env", {}).get("env", {})
print(f"{env.get('"'"'RELAY_STAGE_CYCLE_LIMIT'"'"','"'"''"'"')}|{env.get('"'"'RELAY_LIFETIME_TASK_LIMIT'"'"','"'"''"'"')}")
' "$app"
}

guard_relay_caps() {
  local spec app want_stage want_lifetime values actual_stage actual_lifetime
  for spec in "${RELAY_CAP_EXPECTATIONS[@]}"; do
    IFS='|' read -r app want_stage want_lifetime <<<"$spec"
    values=$(relay_cap_values "$app") || {
      unfixable+=("could not inspect relay caps for $app")
      continue
    }
    IFS='|' read -r actual_stage actual_lifetime <<<"$values"
    if relay_caps_match "$want_stage" "$want_lifetime" "$actual_stage" "$actual_lifetime"; then
      continue
    fi
    if RELAY_STAGE_CYCLE_LIMIT="$want_stage" RELAY_LIFETIME_TASK_LIMIT="$want_lifetime" \
      "$PM2" restart "$app" --update-env >/dev/null 2>&1 &&
      values=$(relay_cap_values "$app") &&
      IFS='|' read -r actual_stage actual_lifetime <<<"$values" &&
      relay_caps_match "$want_stage" "$want_lifetime" "$actual_stage" "$actual_lifetime"; then
      fixed+=("relay caps re-applied to $app")
    else
      unfixable+=("$app relay caps are ${actual_stage:-unset}/${actual_lifetime:-unset}, expected ${want_stage}/${want_lifetime}")
    fi
  done
  "$PM2" save >/dev/null 2>&1 || unfixable+=("pm2 save failed; relay caps may not survive a reboot")
}

# 3. Only a genuinely active autopilot may hold an armed trigger.
guard_autopilot() {
  local armed
  armed=$("${PSQL[@]}" -c "SELECT count(*) FROM autopilot_trigger t JOIN autopilot a ON a.id=t.autopilot_id WHERE t.enabled AND a.status<>'active';" 2>/dev/null)
  [[ "$armed" == "0" ]] && return 0
  if "${PSQL[@]}" -c "UPDATE autopilot_trigger t SET enabled=false, updated_at=now() FROM autopilot a WHERE a.id=t.autopilot_id AND t.enabled AND a.status<>'active';" >/dev/null 2>&1; then
    fixed+=("disarmed $armed trigger(s) on non-active autopilots")
  else
    unfixable+=("could not disarm $armed autopilot trigger(s)")
  fi
}


# 5. Build capacity must persist. The relay binds every Spec->Queue task to one
# agent (relay_stage_config row 2), so that agent's max_concurrent_tasks IS the
# belt's build concurrency. It was found at 1 while 395 flights parked in Spec.
# GSP #626 tracks the proper pooled-agent fix.
#
# 2026-08-31: lowered 9 -> 3. The Tower's global cap is 12 and per-agent caps are
# not additive against it, so a build cap of 9 took 75% of the belt and starved
# QC. Measured at 07:04 UTC: build 9 running / 103 queued (at cap), while
# multica-qc-worker-1 had 0 running against 86 queued and QC held 282 queued in
# total. QC completions had fallen from ~200/hour to ~15/hour and done/hour with
# them, because QC is what issues the verdicts that let a PR merge.
# 3 is the ceiling divided by the four agents that share it (12/4), which fills
# the cap exactly and gives QC 9 slots against build's 3. Adding input to a stage
# whose output is jammed makes the jam worse, and the queue depths above say the
# constraint is downstream of build, not at it.
# Revert: set this back to 9, restore belt-config-guard.sh.pre-slotsplit, and
# re-apply the per-agent caps (QC workers were 5 each). Tracked on GSP-800.
guard_build_capacity() {
  local current
  current=$("${PSQL[@]}" -c "SELECT max_concurrent_tasks FROM agent WHERE name='${BUILD_AGENT}' AND archived_at IS NULL;" 2>/dev/null)
  if [[ -z "$current" ]]; then
    # 2026-09-03: the single deepseek build agent is archived; the build lane is
    # now gsp-build-terra-low-NN (Luna). Per-agent caps on that lane are gated by
    # GSP-1849, so the guard only verifies the lane exists and never rewrites caps.
    local lane
    lane=$("${PSQL[@]}" -c "SELECT count(*) FROM agent WHERE name LIKE 'gsp-build-%' AND archived_at IS NULL;" 2>/dev/null)
    [[ "${lane:-0}" -gt 0 ]] && return 0
    unfixable+=("build lane empty: no non-archived agent named gsp-build-%"); return
  fi
  [[ "$current" == "$WANT_BUILD_CAPACITY" ]] && return 0
  if "${PSQL[@]}" -c "UPDATE agent SET max_concurrent_tasks=${WANT_BUILD_CAPACITY}, updated_at=now() WHERE name='${BUILD_AGENT}' AND archived_at IS NULL;" >/dev/null 2>&1; then
    fixed+=("build capacity re-applied ${current} -> ${WANT_BUILD_CAPACITY} on ${BUILD_AGENT}")
  else
    unfixable+=("could not set ${BUILD_AGENT} max_concurrent_tasks to ${WANT_BUILD_CAPACITY}")
  fi
}

# A pm2 app can carry correct guardrails and still be dead. guard_pm2 checks
# configuration; this checks liveness. multica-relay-advance sat 'stopped' for
# two hours after a pg-pool timeout on 2026-08-30 while guard_pm2 reported
# fixed=0 unfixable=0, and no ticket left 'Queue' for 'In Progress' the whole
# time: that transition has no agent owner in relay_stage_config, so this daemon
# is the only thing that performs it.
guard_pm2_liveness() {
  local app status
  for app in "${LIVENESS_APPS[@]}"; do
    if [[ "$app" == gsp-multica-worker ]] && ai_hold_active; then
      unfixable+=("$app held by ${AI_HOLD_FILE}")
      continue
    fi
    status=$("$PM2" jlist 2>/dev/null | python3 -c "
import json,sys
a=[x for x in json.load(sys.stdin) if x['name']=='$app']
print(a[0]['pm2_env'].get('status','missing') if a else 'missing')
" 2>/dev/null)
    [[ "$status" == online ]] && continue
    # A dead process is serving no flights, so there is nothing to lose by
    # restarting it; the Tower deferral in guard_pm2 guards the live case.
    if "$PM2" restart "$app" >/dev/null 2>&1; then
      fixed+=("pm2 app $app restarted (was ${status:-unknown})")
    else
      unfixable+=("pm2 could not restart $app (status ${status:-unknown})")
    fi
  done
}

# A second relay/worker process races the first one's claims and can double-spend
# a ticket. PM2 normally enforces one app name, but a supervisor restart can
# leave duplicate processes behind. Also fail closed when the paid opt-in does
# not agree with the selected executable: a non-paid lane must never advertise
# paid access, and a paid executable must not run without an explicit opt-in.
guard_single_instance_and_paid_lane() {
  # The wrapper's default must be fail-closed. Explicitly selecting the paid
  # executable still requires MULTICA_ALLOW_PAID_LANE=1; an absent variable on
  # the non-paid Luna/Sol lane must stay 0 rather than inheriting 1.
  if [[ -f "$WRAPPER" ]] && grep -q 'MULTICA_ALLOW_PAID_LANE="${MULTICA_ALLOW_PAID_LANE:-1}"' "$WRAPPER"; then
    if sed -i 's/MULTICA_ALLOW_PAID_LANE:-1/MULTICA_ALLOW_PAID_LANE:-0/' "$WRAPPER"; then
      fixed+=("paid-lane opt-in default repaired to 0 in ${WRAPPER}")
    else
      unfixable+=("could not repair paid-lane opt-in default in ${WRAPPER}")
    fi
  fi
  local snapshot
  snapshot=$("$PM2" jlist 2>/dev/null) || {
    unfixable+=("could not inspect PM2 for duplicate workers or paid-lane drift")
    return 0
  }
  while IFS='|' read -r app count; do
    [[ "$count" =~ ^[0-9]+$ ]] || continue
    (( count <= 1 )) || unfixable+=("${app} has ${count} PM2 entries; single-instance guard refuses paid dispatch")
  done < <(printf '%s' "$snapshot" | python3 -c '
import json,sys,collections
try: data=json.load(sys.stdin)
except Exception: raise SystemExit(0)
counts=collections.Counter(x.get("name") for x in data)
for name in ("gsp-multica-worker","gsp-multica-bridge","multica-relay-advance"):
 print(f"{name}|{counts.get(name,0)}")
')

  local lane paid status
  while IFS='|' read -r lane paid status; do
    [[ "$status" == online ]] || continue
    if [[ "$lane" == paid-openrouter && "$paid" != 1 ]]; then
      unfixable+=("paid OpenRouter executable is online without MULTICA_ALLOW_PAID_LANE=1")
    elif [[ "$lane" == non-paid && "$paid" == 1 ]]; then
      unfixable+=("non-paid executable is online with MULTICA_ALLOW_PAID_LANE=1")
    fi
  done < <(printf '%s' "$snapshot" | python3 -c '
import json,sys
try: data=json.load(sys.stdin)
except Exception: raise SystemExit(0)
for x in data:
 if x.get("name") != "gsp-multica-worker": continue
 e=x.get("pm2_env",{}).get("env",{})
 b=e.get("CODEX_BIN","")
 lane="paid-openrouter" if b.endswith("codex-openrouter") else "non-paid"
 paid=e.get("MULTICA_ALLOW_PAID_LANE","")
 status=x.get("pm2_env",{}).get("status","")
 print(f"{lane}|{paid}|{status}")
')
}

# The GSP relay is only a pipeline if every stage has an owner and every exit has
# a route. Both are plain table rows, and losing one is silent: the belt keeps
# looking busy while nothing is scoped, reviewed or closed. Each row below was
# verified working on 2026-08-31, so drift back is a regression, not a choice.
#
#   1 Registered -> Spec          multica-qc-worker-2   Sol writes the spec
#   2 Spec       -> Queue         gsp-build-deepseek-1  DeepSeek builds
#   4 In Progress-> In Review     multica-qc-worker-1   Sol reviews
#   5 In Review  -> CI/CD & Deploy (none)               multica-cicd-worker owns it
#   6 Human Review-> CI/CD & Deploy (none)               multica-cicd-worker owns it
#
# Rows 5 and 6 deliberately have NO agent, changed 2026-08-31. The relay
# dispatches the agent of the row a flight LEAVES, so the flight is already in
# 'CI/CD & Deploy' when that agent is woken -- and multica-qc-worker-3's own
# instructions say "Stop on any other stage" for anything but Spec or In Review.
# So every one of those dispatches paid a model to read its runbook and halt:
# 625 usage-bearing tasks, 16.17M input and 1.46M output tokens in 24 hours.
# The stage already has a deterministic owner that costs nothing --
# multica-cicd-worker.cjs polls on status and merges -- so the paid dispatch
# bought nothing it did not already have.
#
# Row 5 must also keep 'In Progress' among its successors. Without it the relay
# answers a QC FAIL with 'to_stage is not a configured successor', so failed work
# has no route back to the builder and dies in In Review.
#
# Rows 2 and 4 must keep 'Human Review' for the same reason, added 2026-08-31.
# Some flights have no implementable outcome at all: a migrated duplicate, a
# flight whose canonical issue is already Cancelled, a question rather than a
# build. With 'Queue' (row 2) or 'In Review' (row 4) as the only exit, the
# worker correctly refuses to invent work, gets 409 invalid_transition when it
# tries to park the flight, and the relay re-dispatches it on the next pass.
# Verified before the change: PPP-23529 answered
#   {"error":"invalid_transition","from_stage":"In Progress","to_stage":"Human Review"}
# and after: relay_log_id 2694 moved it to Human Review. Human Review is a real
# park, not another loop: dispatch against the 27 flights parked there fell to
# 9 tasks an hour once they arrived.
# A task records the stage it was created for in context->>'to_stage'. When the
# flight leaves that stage before the task is claimed, the worker wakes, finds
# itself outside the stage its runbook authorises, and parks the flight in Human
# Review -- a paid call that reads a runbook and halts, plus a flight pushed into
# a queue reserved for money and structural decisions. Measured 2026-08-31:
# 22 stale queued tasks, and 5 of the Human Review arrivals in one 20-minute
# window came from exactly this. Cancelling the task costs nothing and leaves the
# flight where it is, so the relay can dispatch it for the stage it is actually in.
guard_stale_stage_tasks() {
  local n
  n=$("${PSQL[@]}" -c "
    WITH stale AS (
      SELECT t.id FROM agent_task_queue t JOIN issue i ON i.id = t.issue_id
       WHERE t.status = 'queued'
         AND i.workspace_id = '${GSP_WS}'::uuid
         AND t.context->>'to_stage' IS NOT NULL
         AND t.context->>'to_stage' <> i.status)
    UPDATE agent_task_queue SET status='cancelled',
           failure_reason='stale_stage_task_flight_moved'
     WHERE id IN (SELECT id FROM stale) RETURNING 1;" 2>/dev/null | grep -c '^1$')
  [[ "${n:-0}" -gt 0 ]] && fixed+=("cancelled ${n} stale-stage task(s) before they could halt on the wrong stage")
  return 0
}

guard_relay_config() {
  local row expected actual
  for row in "1:gsp-spec-sol-low-public" "2:gsp-build-terra-low-02" \
             "3:gsp-build-terra-low-02" "4:gsp-qc-sol-low-1" \
             "5:gsp-deploy-sol-low-1" "6:gsp-deploy-sol-low-1" \
             "7:gsp-deploy-sol-low-1" "11:gsp-build-terra-low-02"; do
    expected="${row#*:}"
    actual=$("${PSQL[@]}" -c "SELECT coalesce(a.name,'(none)') FROM relay_stage_config r
       LEFT JOIN agent a ON a.id=r.agent_id
       WHERE r.id=${row%%:*} AND r.workspace_id='${GSP_WS}'::uuid;" 2>/dev/null)
    [[ "$actual" == "$expected" ]] && continue
    # '(none)' is a real desired state here, not a missing lookup: rows 5 and 6
    # must dispatch nobody. Restoring them by name would re-create the halt-only
    # paid call this guard now exists to prevent.
    local set_clause
    if [[ "$expected" == "(none)" ]]; then
      set_clause="agent_id=NULL, agent_name=NULL"
    else
      set_clause="agent_id=(SELECT id FROM agent WHERE name='${expected}'), agent_name='${expected}'"
    fi
    # psql returns success for an UPDATE that matched zero rows.  Re-read the
    # row so a missing/duplicate workspace configuration cannot be reported as
    # repaired (and so a concurrent guard tick remains idempotent).
    if "${PSQL[@]}" -c "UPDATE relay_stage_config SET ${set_clause}
         WHERE id=${row%%:*} AND workspace_id='${GSP_WS}'::uuid;" >/dev/null 2>&1 &&
       actual=$("${PSQL[@]}" -c "SELECT coalesce(a.name,'(none)') FROM relay_stage_config r
         LEFT JOIN agent a ON a.id=r.agent_id
         WHERE r.id=${row%%:*} AND r.workspace_id='${GSP_WS}'::uuid;" 2>/dev/null) &&
       [[ "$actual" == "$expected" ]]; then
      fixed+=("relay row ${row%%:*} owner restored to ${expected} (was ${actual:-unset})")
    else
      unfixable+=("relay row ${row%%:*} has owner ${actual:-unset}, expected ${expected}")
    fi
  done

  # Done means shipped. 'CI/CD & Deploy' is the only road to 'Done', so no review
  # stage may list 'Done' as a successor: that loophole is how a passing review
  # closed a flight whose pull request was still open. Rows 8 and 9 carry the
  # recovery route back, so a flight closed without shipping can be re-flown.
  local id want why
  for id in 2 3 4 5 6 7 8 9; do
    case "$id" in
      7) want="In Progress,Queue,Spec"
       why="a flight whose PR is open and CONFLICTING can never reach Done, and row 7 had no agent and no alternates at all, so it sat forever; Queue returns it to the builder, Spec covers the legacy flights the spec gate refuses to send straight to a builder, and In Progress is the only route to a reviewer because the review task fires on the row 4 In Progress->In Review exit, which is what a flight with a MERGED pull request but no PASS verdict needs" ;;
    3) want=""
       why="Human Review is money-only; ordinary build failures park instead of escaping from Queue" ;;
    2) want="Cancelled"
         why="Human Review is money-only; a bundled Spec flight may still be cancelled explicitly" ;;
      4) want="Queue"
         why="Human Review is money-only; a failed build may take only the bounded rebuild route" ;;
      5) want="Human Review,In Progress"
         why="QC FAIL must reach the builder and Done must stay unreachable from review" ;;
      # 2026-08-31 09:2x. Two changes, both from measuring how the relay picks
      # an agent. It dispatches the agent on the row whose stage_name equals the
      # stage the flight is LEAVING; next_stage/alt_next_stages only permit a
      # transition and never select the agent. Measured over 12h of
      # relay_run_log joined to the task actually created: 2,520 rows, 15
      # transition types, dispatched == from-stage row agent in 15 of 15.
      #
      # DROPPED Queue. I added it earlier today (GSP-858) believing entry to
      # Queue would dispatch gsp-build-deepseek-flash-1. It does not: leaving
      # Human Review always runs multica-qc-worker-3, and that worker acts only
      # in Spec and In Review and stops anywhere else. So Human Review -> Queue
      # parked a QC worker in a build stage and built nothing. Zero flights had
      # taken the route, so dropping it strands none.
      #
      # ADDED In Review. A flight parked in Human Review carrying a standing QC
      # FAIL had no route back to a reviewer: every QC worker refuses outside
      # In Review ("QC-BLOCKED: this issue is currently Human Review"), so the
      # verdict could never be re-run. 25 flights were deadlocked this way
      # (14 GSP, 11 PPP). This route works because the agent it dispatches is
      # multica-qc-worker-3 and In Review is a stage that worker will act in.
      #
      # To get a parked flight REBUILT, note the builder only ever runs by
      # leaving Spec. The path is Human Review -> CI/CD & Deploy -> Spec (row 7
      # already allows Spec), then Spec -> Queue dispatches the builder.
      # GSP-858, GSP-879. Revert: belt-config-guard.sh.pre-dropqueue
      6) want="Cancelled,In Progress,In Review"
         why="human review must not close a flight without shipping it, so In Progress is the only route back to work; Cancelled is the terminal for a flight a desk proved needs no build at all (16 such flights carried an '## Already satisfied' finding on 2026-08-31 with nothing to ship and no PASS md5, so Done was correctly unreachable and they had no exit)" ;;
      8|9) want="CI/CD & Deploy"
         why="a flight closed without shipping needs a route back to the deploy stage" ;;
    esac
    actual=$("${PSQL[@]}" -c "SELECT array_to_string(alt_next_stages,',') FROM relay_stage_config
      WHERE id=${id} AND workspace_id='${GSP_WS}'::uuid;" 2>/dev/null)
    [[ "$actual" == "$want" ]] && continue
    if "${PSQL[@]}" -c "UPDATE relay_stage_config
         SET alt_next_stages=CASE WHEN '${want}' = '' THEN NULL ELSE string_to_array('${want}', ',') END
       WHERE id=${id} AND workspace_id='${GSP_WS}'::uuid;" >/dev/null 2>&1 &&
       actual=$("${PSQL[@]}" -c "SELECT array_to_string(alt_next_stages,',') FROM relay_stage_config
         WHERE id=${id} AND workspace_id='${GSP_WS}'::uuid;" 2>/dev/null) &&
       [[ "$actual" == "$want" ]]; then
      fixed+=("relay row ${id} successors restored to [${want}] (was [${actual:-unset}]): ${why}")
    else
      unfixable+=("relay row ${id} has successors [${actual:-unset}], expected [${want}]: ${why}")
    fi
  done
}

# Sol QC cannot verify anything without a repository to check out: with repos empty
# every QC run returns QC-BLOCKED and no ticket ever leaves In Review. The admin role
# is what lets the CLI identity write this config at all; demote it and repo-add 403s.
guard_workspace_repos() {
  local repo_count role
  repo_count=$("${PSQL[@]}" -c "SELECT jsonb_array_length(repos) FROM workspace
     WHERE id='${GSP_WS:-f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f}';" 2>/dev/null)
  [[ "$repo_count" =~ ^[0-9]+$ ]] && (( repo_count > 0 )) || \
    unfixable+=("GSP workspace has no repository configured; every Sol QC will return QC-BLOCKED")

  role=$("${PSQL[@]}" -c "SELECT m.role FROM member m JOIN \"user\" u ON u.id=m.user_id
     WHERE m.workspace_id='${GSP_WS:-f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f}'
       AND u.email='team@synthetic.jp';" 2>/dev/null)
  if [[ "$role" != admin && "$role" != owner ]]; then
    if "${PSQL[@]}" -c "UPDATE member SET role='admin'
         WHERE workspace_id='${GSP_WS:-f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f}'
           AND user_id=(SELECT id FROM \"user\" WHERE email='team@synthetic.jp');" >/dev/null 2>&1; then
      fixed+=("CLI identity team@synthetic.jp restored to admin on GSP (was ${role:-absent})")
    else
      unfixable+=("CLI identity team@synthetic.jp holds role ${role:-absent} on GSP; admin verbs will 403")
    fi
  fi
}

# A ticket whose QC task finished while the ticket stayed in In Review is stranded:
# the relay only dispatches QC when a ticket arrives in In Review, so nothing will
# ever look at it again. That is how 30 tickets accumulated while QC was returning
# QC-BLOCKED against an unconfigured repository.
#
# Recovery is two relay hops, In Review -> In Progress -> In Review, which triggers a
# fresh multica-qc-worker-1 dispatch. Each hop spends a paid turn, so the number
# re-driven per run is the belt's own free capacity (the Tower cap of 12 minus what
# is already flying), never a number invented here.
# 2026-08-31: the old headroom bound here was `12 - (queued+running)`, which with
# 300+ queued is always negative, so this guard was a permanent no-op. The bound
# was also the wrong idea: QUEUE DEPTH DOES NOT SPEND. The Tower's global
# concurrency setting limits simultaneous work; an explicit paid token budget is
# the spend admission. Re-driving a stranded flight only adds a queued row and
# costs nothing until a slot frees. Every stranded flight
# is work Tim asked to see finished, so the correct batch size is "all of them".
guard_stranded_review() {
  local number board ws
  while IFS='|' read -r number board; do
    [[ "$number" =~ ^[0-9]+$ ]] || continue
    [[ "$board" == gsp ]] && ws="='${GSP_WS}'" || ws="<>'${GSP_WS}'"
    # Both stage changes use the shared relay helper; the review task fires on
    # row 4's In Progress -> In Review exit.
    if relay_transition "$number" "In Progress" "$board" >/dev/null 2>&1 &&
       relay_transition "$number" "In Review" "$board" >/dev/null 2>&1; then
      fixed+=("${board}#${number} re-driven to a reviewer after being stranded in In Review")
    else
      unfixable+=("${board}#${number} is stranded in In Review and could not be re-driven")
    fi
  done < <("${PSQL[@]}" -F'|' -c "
    SELECT i.number, CASE WHEN i.workspace_id='${GSP_WS}' THEN 'gsp' ELSE 'prod' END
      FROM issue i WHERE i.status='In Review'
       AND NOT EXISTS (SELECT 1 FROM agent_task_queue q
                        WHERE q.issue_id=i.id AND q.status IN ('queued','running'))
     ORDER BY i.updated_at ASC;" 2>/dev/null)
}

# A flight can enter Queue, have its build complete, and never advance, because
# the relay only retries logs still in `pending` and that row is already
# `completed` (GSP-817). Nothing else retries it, so it sits paid-for and idle.
# Re-drive it through the normal path so QC judges the work; QC returns it if the
# build is not real. Bounded by the same headroom as guard_stranded_review.
guard_stranded_queue() {
  local number board ws
  while IFS='|' read -r number board; do
    [[ "$number" =~ ^[0-9]+$ ]] || continue
    [[ "$board" == gsp ]] && ws="='${GSP_WS}'" || ws="<>'${GSP_WS}'"
    # The BUILDER is dispatched on row 2's Spec -> Queue exit, so a rework must
    # leave from Spec. Routing In Progress -> Queue instead fires row 4's QC
    # worker and leaves the flight stranded again; that mistake was made and
    # corrected on 2026-08-31.
    if relay_transition "$number" "Spec" "$board" >/dev/null 2>&1 &&
       relay_transition "$number" "Queue" "$board" >/dev/null 2>&1; then
      fixed+=("${board}#${number} re-driven to the builder after being stranded in Queue")
    else
      # Usually spec_required: no scoper ever wrote a spec comment. Send it to
      # the scoper instead of leaving it parked.
      if relay_transition "$number" "Spec" "$board" >/dev/null 2>&1; then
        fixed+=("${board}#${number} had no spec; sent to the scoper instead of the builder")
      else
        unfixable+=("${board}#${number} is stranded in Queue and could not be re-driven")
      fi
    fi
  done < <("${PSQL[@]}" -F'|' -c "
    SELECT i.number, CASE WHEN i.workspace_id='${GSP_WS}' THEN 'gsp' ELSE 'prod' END
      FROM issue i WHERE i.status='Queue'
       AND NOT EXISTS (SELECT 1 FROM agent_task_queue q
                        WHERE q.issue_id=i.id AND q.status IN ('queued','running'))
     ORDER BY i.updated_at ASC;" 2>/dev/null)
}

# A flight can sit in In Progress with no live task: its build task was
# cancelled by guard_stale_stage_tasks, expired on the 120-minute queue TTL, or
# died on a runtime error. No relay row fires on ENTRY to a stage, so nothing
# ever picks it back up and the flight is stranded with paid work behind it.
# Recovery depends on what the last task actually did:
#   completed -> the build exists, so send it FORWARD to QC (row 4's exit).
#   failed    -> there is no build, so send it back through Spec to the builder.
# Sending completed work back to the builder would pay to rebuild it, so the
# split is not cosmetic. Capped at 3 re-flies per flight.
guard_stranded_inprogress() {

  if queue_backed_up; then
    unfixable+=("guard_stranded_inprogress skipped: queue already backed up past half the 120-minute TTL; re-flying now would only create expiry victims")
    return 0
  fi
  local number board last ws
  while IFS='|' read -r number board last; do
    [[ "$number" =~ ^[0-9]+$ ]] || continue
    [[ "$board" == gsp ]] && ws="='${GSP_WS}'" || ws="<>'${GSP_WS}'"
    if [[ "$last" == completed ]]; then
      if relay_transition "$number" "In Review" "$board" >/dev/null 2>&1; then
        if increment_reflight_metadata "$number" "$board" ip_reflies; then
          fixed+=("${board}#${number} stranded in In Progress with a completed build; sent forward to QC")
        else
          unfixable+=("${board}#${number} reached In Review but retry metadata could not be recorded")
        fi
      else
        unfixable+=("${board}#${number} is stranded in In Progress and could not be sent to QC")
      fi
    elif [[ "$last" == failed ]]; then
      if relay_transition "$number" "Spec" "$board" >/dev/null 2>&1 &&
         relay_transition "$number" "Queue" "$board" >/dev/null 2>&1; then
        if increment_reflight_metadata "$number" "$board" ip_reflies; then
          fixed+=("${board}#${number} stranded in In Progress with no build; re-driven to the builder")
        else
          unfixable+=("${board}#${number} reached Queue but retry metadata could not be recorded")
        fi
      else
        unfixable+=("${board}#${number} is stranded in In Progress and could not be re-driven")
      fi
    else
      unfixable+=("${board}#${number} is stranded in In Progress with unknown task history; left unchanged")
    fi
  done < <("${PSQL[@]}" -F'|' -c "
    SELECT i.number,
           CASE WHEN i.workspace_id='${GSP_WS}' THEN 'gsp' ELSE 'prod' END,
           coalesce((SELECT q.status FROM agent_task_queue q
                      WHERE q.issue_id=i.id ORDER BY q.created_at DESC LIMIT 1),'none')
      FROM issue i
     WHERE i.status='In Progress'
       AND i.parent_issue_id IS NULL
       AND coalesce(i.metadata->>'ip_reflies','0')::int < 3
       AND NOT EXISTS (SELECT 1 FROM agent_task_queue q
                        WHERE q.issue_id=i.id AND q.status IN ('queued','running'))
     ORDER BY i.updated_at ASC LIMIT 15;" 2>/dev/null)
}

# Retry counters are guarded in the same statement that writes them.  The
# workspace predicate and active-task check make this idempotent when two guard
# ticks overlap, while the cap prevents an endlessly expiring flight loop.
increment_reflight_metadata() {
  local number="$1" board="${2:-gsp}" key="${3:-spec_reflies}"
  [[ "$key" =~ ^[a-z_]+$ ]] || return 1
  local updated
  # psql exits zero when an UPDATE matches no rows.  Require the RETURNING
  # receipt so a concurrent guard or an exhausted retry budget is reported as
  # unfixable instead of claiming a re-flight that was never recorded.
  updated=$("${PSQL[@]}" -c "UPDATE issue SET metadata = coalesce(metadata,'{}'::jsonb) ||
    jsonb_build_object('${key}', (coalesce(metadata->>'${key}','0')::int + 1)::text)
    WHERE number=${number} AND workspace_id = CASE WHEN '${board}'='gsp' THEN '${GSP_WS}' ELSE 'da3c5c5c-a123-4567-b999-c3ed1820da00' END
      AND coalesce(metadata->>'${key}','0')::int < 3
      AND NOT EXISTS (SELECT 1 FROM agent_task_queue q WHERE q.issue_id=issue.id AND q.status IN ('queued','running'))
    RETURNING number;" 2>/dev/null </dev/null) || return 1
  [[ "$(printf '%s' "$updated" | tr -d '[:space:]')" == "$number" ]]
}

# A bundled child is closed by its mega flight's change, but nothing moves the
# child itself, so without this it sits open forever after the work has shipped —
# the same "nothing ever closes" failure the bundling rule exists to prevent.
# The child is dispositioned, not built: it never had a specification of its own.
relay_cancel_child() {
  local child_id="$1" parent_number="$2" agent operator body receipt
  [[ "${RELAY_PREFLIGHT_OK:-1}" == 1 ]] || return 1
  agent=$(sed -n 's/^RELAY_AGENT_SECRET=//p' "$RELAY_ENV_FILE" | tail -1)
  operator=$(sed -n 's/^RELAY_OPERATOR_SECRET=//p' "$RELAY_ENV_FILE" | tail -1)
  [[ -z "$agent" || -z "$operator" ]] && return 1
  body=$(printf '{"issue_id":"%s","to_stage":"Cancelled","agent_token":"%s","reason":"Folded into mega flight gsp#%s (Done), which carried the specification and the change for this report.","evidence":{"boardOwnerAuthority":"belt-config-guard bundled-child rule","reason":"child of completed mega gsp#%s"}}' \
    "$child_id" "$agent" "$parent_number" "$parent_number")
  receipt=$(curl -sS -X POST http://127.0.0.1:5005/relay/advance -H 'content-type: application/json' \
    -H "x-relay-operator-secret: $operator" -d "$body" 2>&1) || return 1
  jq -e '(.success == true) and ((.issue.status // .current_status // .status) == "Cancelled")' \
    >/dev/null 2>&1 <<<"$receipt"
}

guard_bundled_children() {
  local child_id number parent_number
  while IFS='|' read -r child_id number parent_number; do
    [[ -z "$child_id" ]] && continue
    "$SK" multica issue-comment-add "$child_id" --content \
      "Closed by mega flight gsp#${parent_number}, which carried the specification and the change for this report." \
      >/dev/null 2>&1 </dev/null
    # 2026-09-03: terminal statuses are relay-owned (sk issue-update refuses
    # Done) and Queue->Cancelled needs the operator actor + cancelled evidence
    # (transition-policy.cjs:24,61). Fold the child as Cancelled via the relay.
    if relay_cancel_child "$child_id" "$parent_number"; then
      fixed+=("gsp#${number} closed: its mega flight gsp#${parent_number} is done")
    else
      unfixable+=("gsp#${number} is a child of completed gsp#${parent_number} but could not be closed")
    fi
  done < <("${PSQL[@]}" -F'|' -c "SELECT c.id, c.number, p.number
     FROM issue c JOIN issue p ON p.id = c.parent_issue_id
    WHERE c.workspace_id='f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f'
      AND p.status IN ('Done','Archived')
      AND c.status NOT IN ('Done','Archived','Cancelled');" 2>/dev/null)
}

# A child is dispatched only through its parent (reconciler.cjs:103). When the
# parent is Cancelled (rollup dismantled) or a PPP parent is Done with its
# closing note leaving the children as independent work (PPP-23706, 2026-09-03),
# the children strand in Queue/Spec forever. Detach them so the reconciler
# dispatches each on its own; a child the parent's PR already covered ends as a
# NO_OP build, which is cheaper than a stranded ticket.
guard_freed_children() {
  local child_id number parent_number parent_status board
  while IFS='|' read -r child_id number parent_number parent_status board; do
    [[ -z "$child_id" ]] && continue
    if "${PSQL[@]}" -c "SELECT set_config('multica.relay_authorized','on',true);
         UPDATE issue SET parent_issue_id=NULL, updated_at=NOW() WHERE id='${child_id}'::uuid;" >/dev/null 2>&1; then
      "$SK" multica comment --board "$board" --number "$number" --body \
        "/note Detached from rollup #${parent_number} (${parent_status}) so the belt dispatches this ticket on its own; the reconciler never dispatches a child." \
        >/dev/null 2>&1 </dev/null
      fixed+=("#${number} detached from ${parent_status} rollup #${parent_number}")
    else
      unfixable+=("#${number} is a child of ${parent_status} rollup #${parent_number} and could not be detached")
    fi
  done < <("${PSQL[@]}" -F'|' -c "SELECT c.id, c.number, p.number, p.status,
       CASE WHEN c.workspace_id='${GSP_WS}' THEN 'gsp' ELSE 'prod' END
     FROM issue c JOIN issue p ON p.id = c.parent_issue_id
    WHERE c.status NOT IN ('Done','Archived','Cancelled')
      AND (p.status = 'Cancelled'
           OR (p.status IN ('Done','Archived') AND c.workspace_id='da3c5c5c-a123-4567-b999-c3ed1820da00'));" 2>/dev/null)
}

# The relay dispatches on transition out of a stage, so parking or cancelling a
# flight queues a paid build on work that must not be built (GSP-808). Until that
# is fixed the calls keep being spent, so cancel them here. Scoped to build
# agents only: a QC worker on a Human Review flight may be the legitimate
# row-6 merge step, and this guard must not guess about that.
# A gsp ticket created straight into 'Spec' never gets a scoper, because the
# scoper (relay_stage_config row 1) is dispatched on the Registered -> Spec exit
# only. Without a scoper there is no comment carrying '## Spec' and '## Evidence',
# and multica-bridge.cjs:57-69 then refuses Spec -> Queue forever. `sk multica
# create` does exactly this, so every ticket an agent files is dead on arrival
# (107 found on 2026-08-31, arriving at ~25/hour). GSP-836 fixes the CLI; this
# keeps the board draining until that lands.
# Routing the flight out of Spec any other way would fire row 2's PAID builder,
# so both stage changes use the relay helper and preserve the free row-1 scoper
# dispatch from Registered -> Spec.
# Nothing advances a flight out of Registered. The relay dispatches the agent of
# the row a flight LEAVES, and row 1 is Registered -> Spec, so a flight parked in
# Registered has no agent, no task and no timer: it waits forever for a push that
# never comes. That is where every rescued or unbundled flight lands, so the
# rescue path itself was a dead end. 13 sat this way on 2026-08-31, including the
# children freed when a bucket MEGA was dismantled. Advancing them to Spec is the
# one transition that fires the scoper.
guard_stranded_registered() {

  if queue_backed_up; then
    unfixable+=("guard_stranded_registered skipped: queue already backed up past half the 120-minute TTL; re-flying now would only create expiry victims")
    return 0
  fi
  local number board
  while IFS='|' read -r number board; do
    [[ "$number" =~ ^[0-9]+$ ]] || continue
    if relay_transition "$number" "Spec" "$board" >/dev/null 2>&1; then
      fixed+=("#${number} was parked in Registered with nothing to advance it; sent to Spec for scoping")
    else
      unfixable+=("#${number} is stuck in Registered and could not be advanced to Spec")
    fi
  done < <("${PSQL[@]}" -c "
    SELECT i.number, CASE WHEN i.workspace_id='${GSP_WS}' THEN 'gsp' ELSE 'prod' END FROM issue i
     WHERE i.status='Registered'
       AND i.workspace_id IN ('${GSP_WS}','da3c5c5c-a123-4567-b999-c3ed1820da00')
       AND NOT EXISTS (SELECT 1 FROM agent_task_queue q
                        WHERE q.issue_id=i.id AND q.status IN ('queued','running','dispatched'))
     ORDER BY i.created_at LIMIT 40;" 2>/dev/null)
}

# Human Review is for money and big structural calls only (Tim, 2026-08-31).
# Workers also park there when they cannot write a spec, so it silently becomes a
# graveyard: 128 flights on 2026-08-31, of which only 13 were real human
# decisions. Releasing them by hand is not a fix -- they come straight back. This
# releases automatically, but BOUNDED: each flight gets at most two automatic
# releases, recorded in metadata.hr_releases, after which it stays put rather
# than becoming a paid loop. Money-titled flights are never touched, and neither
# is anything whose latest comment says a human must decide.
guard_human_review_release() {
  local number board
  while IFS='|' read -r number board; do
    [[ "$number" =~ ^[0-9]+$ ]] || continue
    if relay_transition "$number" "Registered" "$board" >/dev/null 2>&1 &&
       "${PSQL[@]}" -c "SELECT set_config('multica.relay_authorized','on',true);
         UPDATE issue SET metadata = coalesce(metadata,'{}'::jsonb) ||
         jsonb_build_object('hr_releases', (coalesce(metadata->>'hr_releases','0')::int + 1)::text)
         WHERE number=${number} AND status='Registered';" >/dev/null 2>&1 </dev/null &&
       relay_transition "$number" "Spec" "$board" >/dev/null 2>&1; then
      fixed+=("#${number} released from Human Review for scoping (not a money or structural call)")
    else
      unfixable+=("#${number} could not be released from Human Review")
    fi
  done < <("${PSQL[@]}" -c "
    SELECT i.number, CASE WHEN i.workspace_id='${GSP_WS}' THEN 'gsp' ELSE 'prod' END FROM issue i
    LEFT JOIN LATERAL (SELECT content FROM comment
                        WHERE issue_id=i.id ORDER BY created_at DESC LIMIT 1) c ON true
     WHERE i.status='Human Review'
       AND i.workspace_id IN ('${GSP_WS}','da3c5c5c-a123-4567-b999-c3ed1820da00')
       AND coalesce(i.metadata->>'hr_releases','0')::int < 2
       AND i.title !~* 'money|billing|payment|invoice|charge|spend|cost|refund|zelle|stripe'
       AND coalesce(c.content,'') !~* 'human approval required|Tim to |Tim must|money authorization|requires Tim'
     ORDER BY i.updated_at LIMIT 25;" 2>/dev/null)
}

spec_receipt_status() {
  jq -e -r 'if type != "object" then error("not-object") else (.current_status // .status // .result // .to_stage // .stage // empty) end' 2>/dev/null
}

spec_receipt_task_id() {
  jq -e -r '.task_id // .pending_task_id // .selected_task_id // .task.id // .task.task_id // .result.task_id // .result.pending_task_id // empty' 2>/dev/null
}

# All recovery status changes go through this single relay entry point.  Keeping
# the board and target together prevents a gsp number from being accidentally
# advanced on prod (and vice versa), while the captured receipt lets callers
# distinguish a relay refusal from a successful, idempotent no-op.
relay_transition() {
  local number="$1" target="$2" board="${3:-gsp}" md5="${4:-}"
  # Keep this boundary deliberately strict: callers must not be able to turn
  # a recovery row into an arbitrary board/transition (or inject CLI flags).
  [[ "$number" =~ ^[0-9]+$ ]] || {
    RELAY_TRANSITION_OUTPUT='invalid ticket number'; RELAY_TRANSITION_RC=64
    RELAY_TRANSITION_CLASS=configuration; return 64
  }
  [[ "$board" == gsp || "$board" == prod ]] || {
    RELAY_TRANSITION_OUTPUT='invalid board'; RELAY_TRANSITION_RC=64
    RELAY_TRANSITION_CLASS=configuration; return 64
  }
  case "$target" in
    Spec|Queue|In\ Progress|In\ Review|Registered|Human\ Review|CI/CD\ \&\ Deploy|Done|Cancelled|Archived) ;;
    *) RELAY_TRANSITION_OUTPUT='invalid target stage'; RELAY_TRANSITION_RC=64
       RELAY_TRANSITION_CLASS=configuration; return 64 ;;
  esac
  if [[ -n "$md5" && ! "$md5" =~ ^[0-9a-fA-F]{32}$ ]]; then
    RELAY_TRANSITION_OUTPUT='invalid work-product digest'; RELAY_TRANSITION_RC=64
    RELAY_TRANSITION_CLASS=configuration; return 64
  fi
  if [[ "${RELAY_PREFLIGHT_OK:-1}" != 1 ]]; then
    RELAY_TRANSITION_OUTPUT="relay preflight refused: ${RELAY_PREFLIGHT_DIAGNOSTIC:-invalid configuration}"
    RELAY_TRANSITION_RC=78; RELAY_TRANSITION_CLASS=configuration
    return "$RELAY_TRANSITION_RC"
  fi
  if [[ "${PARITY_OK:-1}" != 1 ]]; then
    RELAY_TRANSITION_OUTPUT="runtime/source parity refused: ${PARITY_DIAGNOSTIC:-digest mismatch}"
    RELAY_TRANSITION_RC=78; RELAY_TRANSITION_CLASS=configuration
    return "$RELAY_TRANSITION_RC"
  fi
  local -a args=(multica advance "$number" --to "$target" --board "$board")
  [[ -n "$md5" ]] && args+=(--current-work-product-md5 "$md5")
  RELAY_TRANSITION_OUTPUT=$("$SK" "${args[@]}" 2>&1 </dev/null)
  RELAY_TRANSITION_RC=$?
  RELAY_TRANSITION_CLASS=$(relay_failure_class "$RELAY_TRANSITION_OUTPUT" "$RELAY_TRANSITION_RC")
  return "$RELAY_TRANSITION_RC"
}

# Classify only bounded, redacted text.  This is used for operator diagnostics
# and never changes retry behavior: authority/configuration and transport
# failures remain fail-closed, while ordinary transition refusals are distinct.
relay_failure_class() {
  local message
  message=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  if [[ "$message" =~ (malformed|not-json|parse|invalid[[:space:]]+json) ]]; then
    printf 'malformed-receipt'
  elif [[ "$2" == 64 || "$2" == 78 || "$message" =~ (authority|permission|forbidden|unauthori|credential|secret|workspace|configuration|invalid) ]]; then
    printf 'authority/configuration'
  elif [[ "$message" =~ (transport|timeout|connection|unavailable|relay[[:space:]]+post|network) ]]; then
    printf 'transport'
  else
    printf 'transition-refusal'
  fi
}

relay_transition_diagnostic() {
  local output="${1:-${RELAY_TRANSITION_OUTPUT:-}}"
  printf '%s' "$output" | tr '\n' ' ' \
    | sed -E -e 's/(Bearer[[:space:]]+)[^[:space:]]+/\1[REDACTED]/Ig' \
             -e 's/((token|password|secret|api[_-]?key)[=:])[[:space:]]*[^[:space:]]+/\1[REDACTED]/Ig' \
    | cut -c1-400
}

guard_stranded_spec() {

  if queue_backed_up; then
    unfixable+=("guard_stranded_spec skipped: queue already backed up past half the 120-minute TTL; re-flying now would only create expiry victims")
    return 0
  fi
  # A queued task is dropped after a hard 120-minute queue TTL (failure_reason
  # 'queued_expired'): 514 tasks died that way in one day. Nothing re-queues the
  # ticket, so it sits in Spec with a completed-but-failed task forever. The
  # original guard only caught tickets with ZERO tasks ever, so every expiry
  # victim was invisible to it. Catch "no ACTIVE task" instead, and cap re-flies
  # at 3 per ticket so a ticket that keeps expiring cannot become a paid loop.
  local number board
  while IFS='|' read -r number board; do
    [[ "$number" =~ ^[0-9]+$ ]] || continue
    recover_stranded_spec_flight "$number" "$board"
  done < <("${PSQL[@]}" -F'|' -c "
    SELECT i.number, CASE WHEN i.workspace_id='${GSP_WS}' THEN 'gsp' ELSE 'prod' END FROM issue i
    WHERE i.status='Spec' AND i.workspace_id IN ('${GSP_WS}','da3c5c5c-a123-4567-b999-c3ed1820da00')
      AND i.parent_issue_id IS NULL
      AND coalesce(i.metadata->>'spec_reflies','0')::int < 3
      AND NOT EXISTS (SELECT 1 FROM agent_task_queue q
                       WHERE q.issue_id=i.id AND q.status IN ('queued','running'))
    ORDER BY i.created_at LIMIT 25;" 2>/dev/null)
}

# A stranded flight is already in Spec.  The only supported recovery exit is
# Spec -> Queue, which dispatches the builder through the relay.  Older code
# tried Spec -> Registered -> Spec to obtain a scoper task; that edge is not in
# the stage policy and is rejected by the relay-authority guard.
spec_refly_queue() {
  relay_transition "$1" "Queue" "${2:-gsp}"; SPEC_REFLOW_RC=$?
  SPEC_REFLOW_OUTPUT="$RELAY_TRANSITION_OUTPUT"
}

redact_spec_refly_diagnostic() {
  printf '%s' "$1" | tr '\n' ' ' | sed -E -e 's/(Bearer[[:space:]]+)[^[:space:]]+/\1[REDACTED]/Ig' -e 's/((token|password|secret|api[_-]?key)[=:])[[:space:]]*[^[:space:]]+/\1[REDACTED]/Ig' | cut -c1-400
}

spec_refly_failure_class() {
  local message
  message=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  case "$message" in
    *relay\ authority*|*relay_authorized*|*authority*|*permission*|*forbidden*|*unauthori*) printf 'relay-authority' ;;
    *credential*|*bearer*|*api[_-]key*|*token*) printf 'credential' ;;
    *malformed*|*not-json*|*parse*) printf 'malformed-receipt' ;;
    *transport*|*timeout*|*connection*|*unavailable*|*relay\ post*) printf 'transport' ;;
    *) printf 'relay' ;;
  esac
}

spec_refly_receipt_valid() {
  jq -e '(.success == true) and (.issue.status == "Queue") and ((.task_id | type) == "string") and (.task_id | length > 0)' >/dev/null 2>&1 <<<"$1"
}

spec_refly_increment_metadata() {
  local number="$1" board="${2:-gsp}"
  local updated
  # Treat an exhausted/concurrent retry gate as a refusal.  psql exits zero
  # for UPDATE 0, which previously made a second guard run claim a repair even
  # though no counter changed (and made the success report non-idempotent).
  updated=$("${PSQL[@]}" -c "UPDATE issue SET metadata = coalesce(metadata,'{}'::jsonb) ||
    jsonb_build_object('spec_reflies', (coalesce(metadata->>'spec_reflies','0')::int + 1)::text)
    WHERE number=${number} AND workspace_id = CASE WHEN '${board}'='gsp' THEN '${GSP_WS}' ELSE 'da3c5c5c-a123-4567-b999-c3ed1820da00' END AND status='Queue'
      AND parent_issue_id IS NULL AND coalesce(metadata->>'spec_reflies','0')::int < 3
    RETURNING number;" 2>/dev/null </dev/null) || return 1
  [[ "$(printf '%s' "$updated" | tr -d '[:space:]')" == "$number" ]]
}

done_receipt_valid() {
  jq -e '(.success == true) and ((.issue.status // .current_status // .status) == "Done")' >/dev/null 2>&1 <<<"$1"
}

# A PASS can mention more than one pull request.  Do not ship a flight with no
# parseable PR, and do not ship until every referenced PR is actually merged.
all_referenced_prs_merged() {
  local urls="$1" repo num state found=0 u
  for u in ${urls//,/ }; do
    [[ "$u" =~ ^https://github\.com/[^/[:space:]]+/[^/[:space:]]+/pull/[0-9]+$ ]] || return 1
    repo=$(printf '%s' "$u" | sed -E 's|https://github.com/([^/]+/[^/]+)/pull/[0-9]+|\1|')
    num=$(printf '%s' "$u" | sed -E 's|.*/pull/([0-9]+)|\1|')
    state=$(gh pr view "$num" -R "$repo" --json state -q .state 2>/dev/null </dev/null)
    [[ "$state" == MERGED ]] || return 1
    found=1
  done
  (( found ))
}

recover_stranded_spec_flight() {
  local number="$1" board="${2:-gsp}" relay_output diagnostic
  spec_refly_queue "$number" "$board"; relay_output="$SPEC_REFLOW_OUTPUT"
  if [[ "$SPEC_REFLOW_RC" -ne 0 ]]; then
    diagnostic=$(relay_transition_diagnostic "$relay_output")
    unfixable+=("${board}#${number} stranded-Spec recovery failed phase=relay class=${RELAY_TRANSITION_CLASS:-$(spec_refly_failure_class "$relay_output")} exit=${SPEC_REFLOW_RC} diagnostic=${diagnostic}")
    return 0
  fi
  if ! spec_refly_receipt_valid "$relay_output"; then
    diagnostic=$(redact_spec_refly_diagnostic "$relay_output")
    unfixable+=("${board}#${number} stranded-Spec recovery failed phase=receipt exit=0 diagnostic=${diagnostic}")
    return 0
  fi
  if ! spec_refly_increment_metadata "$number" "$board"; then
    unfixable+=("${board}#${number} stranded-Spec recovery failed phase=metadata exit=1 diagnostic=retry counter update refused; issue left in Queue")
    return 0
  fi
  fixed+=("${board}#${number} had no live builder task; re-flown to Queue with a builder task receipt")
}

# Row 7 (CI/CD & Deploy -> Done) has NO agent, so nothing ever performs the last
# step: every flight that passes QC sits in the deploy stage until a human closes
# it by hand. That is the merge-train stall on GSP-811 seen from the other end.
# Done is gated on --current-work-product-md5 matching the artifact that earned
# the PASS, so this ships only flights that really passed, and only once their
# pull request is actually MERGED. A flight whose PR is still open is left alone;
# guard_unshipped_closures already handles that direction.
guard_ship_passed() {
  local number board md5 urls url
  # Every PR the flight references must be merged, not just the most recently
  # mentioned one. gsp#83 cites sk-cli#316 (merged) and #498 (open): checking a
  # single URL shipped it to Done, guard_unshipped_closures dragged it back on
  # the next run, and the two guards oscillated once every five minutes.
  while IFS='|' read -r number board md5 urls; do
    [[ "$number" =~ ^[0-9]+$ ]] || continue
    [[ "$md5" =~ ^[0-9a-f]{32}$ ]] || continue
    all_referenced_prs_merged "$urls" || continue
    url="${urls##*,}"
    relay_transition "$number" Done "$board" "$md5" >/dev/null 2>&1
    if [[ "$RELAY_TRANSITION_RC" -eq 0 ]] && done_receipt_valid "$RELAY_TRANSITION_OUTPUT"; then
      fixed+=("${board}#${number} shipped to Done on its PASS verdict${url:+ after ${url##*/} merged}")
    else
      unfixable+=("${board}#${number} passed QC and its work is merged but it would not advance to Done")
    fi
  done < <("${PSQL[@]}" -F'|' -c "
    SELECT i.number,
           CASE WHEN i.workspace_id='${GSP_WS}' THEN 'gsp' ELSE 'prod' END,
           v.work_product_md5,
           coalesce((SELECT string_agg(DISTINCT m[1], ',') FROM comment c
                       CROSS JOIN LATERAL regexp_matches(c.content,
                         'https://github.com/[^ )\\\`\"]+/pull/[0-9]+','g') m
                      WHERE c.issue_id=i.id),'')
      FROM issue i
      JOIN LATERAL (SELECT verdict, work_product_md5 FROM qc_verdict
                     WHERE issue_id=i.id ORDER BY created_at DESC LIMIT 1) v ON true
     WHERE i.status='CI/CD & Deploy' AND v.verdict='PASS';" 2>/dev/null)
}

guard_parked_dispatch() {
  local number agent
  while IFS='|' read -r number agent; do
    [[ "$number" =~ ^[0-9]+$ ]] || continue
    fixed+=("task for ${agent} on parked/terminal flight #${number} cancelled (GSP-808)")
  done < <("${PSQL[@]}" -F'|' -c "
    UPDATE agent_task_queue t SET status='cancelled',
      error='dispatch onto a parked or terminal flight; not actionable (GSP-808)'
    FROM issue i, agent a
    WHERE i.id=t.issue_id AND a.id=t.agent_id AND t.status='queued'
      AND (
        -- Terminal: no agent of any kind has anything to do on a closed flight.
        i.status IN ('Cancelled','Archived')
        -- Parked but still live: only a BUILD task is certainly wrong here. A QC
        -- task on a 'Human Review' or 'Done' flight can be the legitimate row 6
        -- merge step, and cancelling those blind destroyed 6 real merge tasks
        -- earlier on 2026-08-31.
        OR (a.name ~ '^(gsp-)?build' AND i.status IN ('Human Review','Done'))
      )
    RETURNING i.number, a.name;" 2>/dev/null)
}

# The spec gate lives in the bridge process, so an edited file is not an enforced
# rule: the running process keeps the code it started with. This checks the rule
# is still in the source AND that the process is newer than the source, and
# restarts the bridge when it is running stale code.
readonly BRIDGE_SRC=/home/newadmin/gsp-multica/multica-bridge.cjs
guard_spec_gate() {
  local src_mtime started
  if ! grep -q 'SPEC_ENFORCED_WORKSPACE' "$BRIDGE_SRC" 2>/dev/null; then
    unfixable+=("the relay spec gate is missing from ${BRIDGE_SRC}; unspecified work can reach a builder")
    return 0
  fi
  src_mtime=$(stat -c %Y "$BRIDGE_SRC" 2>/dev/null) || return 0
  started=$("$PM2" jlist 2>/dev/null | python3 -c "
import json,sys
a=[x for x in json.load(sys.stdin) if x['name']=='gsp-multica-bridge']
print(int(a[0]['pm2_env'].get('pm_uptime',0)//1000) if a else 0)
" 2>/dev/null)
  [[ "$started" =~ ^[0-9]+$ ]] && (( started > 0 )) || return 0
  if (( src_mtime > started )); then
    if "$PM2" restart gsp-multica-bridge >/dev/null 2>&1; then
      fixed+=("bridge restarted; it was running relay code older than ${BRIDGE_SRC}")
    else
      unfixable+=("bridge is running code older than ${BRIDGE_SRC} and would not restart")
    fi
  fi
}

# Done means shipped, so a closed flight whose pull request is still open was
# never shipped and the board is lying about it. The relay gained a route back
# from Done and Archived to the deploy stage; this is what walks flights down it.
#
# Bounded on purpose: only flights closed in the last day, at most BATCH per run,
# one GitHub read each. A wider sweep would spend hundreds of API calls every
# quarter hour to re-check flights that were already shipped correctly.
guard_unshipped_closures() {
  local batch=8 rows number status url repo num state moved=0
  rows=$("${PSQL[@]}" -c "
    SELECT i.number, i.status,
           (regexp_match(c.content,'https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[0-9]+'))[1]
    FROM issue i JOIN LATERAL (
      SELECT content FROM comment c2 WHERE c2.issue_id=i.id
        AND c2.content ~ 'https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[0-9]+'
      ORDER BY c2.created_at DESC LIMIT 1) c ON TRUE
    WHERE i.workspace_id='${GSP_WS}' AND i.status IN ('Done','Archived')
      AND i.updated_at > now() - interval '1 day'
    ORDER BY i.updated_at DESC LIMIT ${batch};" 2>/dev/null)

  while IFS='|' read -r number status url; do
    [[ -z "$number" || -z "$url" ]] && continue
    repo=$(printf '%s' "$url" | sed -E 's|https://github.com/([^/]+/[^/]+)/pull/[0-9]+|\1|')
    num=$(printf '%s' "$url" | sed -E 's|.*/pull/([0-9]+)|\1|')
    state=$(gh pr view "$num" -R "$repo" --json state -q .state 2>/dev/null </dev/null)
    [[ "$state" != OPEN ]] && continue
    if relay_transition "$number" "CI/CD & Deploy" gsp >/dev/null 2>&1; then
      fixed+=("gsp#${number} was ${status} while ${repo}#${num} is still open; returned to CI/CD & Deploy")
      moved=$(( moved + 1 ))
    else
      unfixable+=("gsp#${number} is ${status} but ${repo}#${num} is still open, and it will not return to the deploy stage")
    fi
  done <<< "$rows"
  return 0
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
# Validate relay authority before any guard can attempt a status mutation.
guard_relay_preflight
repair_source_runtime_parity
guard_source_runtime_parity
guard_wrapper; guard_tower_process; guard_pm2; guard_relay_caps; guard_autopilot; guard_build_capacity; guard_pm2_liveness; guard_single_instance_and_paid_lane; guard_stale_stage_tasks; guard_relay_config; guard_workspace_repos; guard_stranded_review; guard_stranded_queue; guard_stranded_inprogress; guard_stranded_registered; guard_human_review_release; guard_bundled_children; guard_freed_children; guard_spec_gate; guard_stranded_spec; guard_ship_passed; guard_parked_dispatch; guard_unshipped_closures

# Several guards can observe the same flight in one tick. Emit each exact
# finding once so the P0 is stable and one-run idempotent.
declare -A _seen_fixed=() _seen_unfixable=()
for f in "${fixed[@]:-}"; do
  [[ -n "$f" && -z "${_seen_fixed[$f]+x}" ]] || continue
  _seen_fixed[$f]=1; echo "belt-config-guard: FIXED $f"
done
for u in "${unfixable[@]:-}"; do
  [[ -n "$u" && -z "${_seen_unfixable[$u]+x}" ]] || continue
  _seen_unfixable[$u]=1; echo "belt-config-guard: UNFIXABLE $u" >&2
done

if (( ${#unfixable[@]} > 0 )) && [[ -n "${unfixable[0]:-}" ]]; then
  file_p0 "belt config drift the guard could not repair" \
"Automated by belt-config-guard.sh on gsp-noc2 at $(date -Is).

Could not repair:
$(printf '%s\n' "${!_seen_unfixable[@]}" | sort | sed 's/^/  - /')

Repaired automatically this run:
$(if ((${#_seen_fixed[@]})); then printf '%s\n' "${!_seen_fixed[@]}" | sort | sed 's/^/  - /'; else printf '  - none\n'; fi)"
fi
echo "belt-config-guard: fixed=${#fixed[@]} unfixable=${#unfixable[@]}"
fi
