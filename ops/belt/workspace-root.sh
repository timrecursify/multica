#!/usr/bin/env bash
set -euo pipefail
readonly BELT_CANONICAL_WORKSPACES_ROOT="/var/lib/gsp/multica/workspaces"
readonly BELT_WORKSPACE_UUIDS=("da3c5c5c-a123-4567-b999-c3ed1820da00" "f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f")
workspace_root_resolve() {
  local configured="${MULTICA_DAEMON_WORKSPACES_ROOT-${MULTICA_WORKSPACES_ROOT-$BELT_CANONICAL_WORKSPACES_ROOT}}"
  if [[ -n "${MULTICA_DAEMON_WORKSPACES_ROOT-}" && -n "${MULTICA_WORKSPACES_ROOT-}" &&
        "$MULTICA_DAEMON_WORKSPACES_ROOT" != "$MULTICA_WORKSPACES_ROOT" ]]; then
    echo "daemon and belt workspace roots disagree" >&2; return 64
  fi
  if [[ ! -v MULTICA_DAEMON_WORKSPACES_ROOT && ! -v MULTICA_WORKSPACES_ROOT && -n "${BELT_WORKSPACES_ROOT_OVERRIDE-}" ]]; then
    [[ "${BELT_TEST_MODE-0}" == 1 ]] || { echo "workspace root override is restricted to BELT_TEST_MODE=1" >&2; return 64; }
    configured="$BELT_WORKSPACES_ROOT_OVERRIDE"
  fi
  if [[ "${BELT_TEST_MODE-0}" != 1 && "$configured" != "$BELT_CANONICAL_WORKSPACES_ROOT" ]]; then
    echo "workspace root is not canonical: $configured" >&2; return 64
  fi
  [[ -n "$configured" && "$configured" == /* ]] || { echo "workspace root must be an absolute path" >&2; return 64; }
  [[ -d "$configured" && ! -L "$configured" ]] || { echo "workspace root must be an existing non-symlink directory: $configured" >&2; return 64; }
  [[ "$(realpath -e -- "$configured")" == "$configured" ]] || { echo "workspace root must be canonical: $configured" >&2; return 64; }
  printf '%s\n' "$configured"
}
workspace_root_validate_children() {
  local root="$1" child name allowed bad=0 quarantine_dir quarantine_target
  while IFS= read -r -d '' child; do
    name="${child##*/}"
    # The canonical root also holds belt infrastructure beside the workspace
    # directories -- .repos (the bare-clone cache QC reads), .multica and
    # .skill-cache. They are not workspaces and never were drift, so treating
    # them as such refuses to start the worker on a correctly provisioned host.
    [[ "$name" == .* ]] && continue
    allowed=0
    for uuid in "${BELT_WORKSPACE_UUIDS[@]}"; do [[ "$name" == "$uuid" ]] && allowed=1; done
    if (( ! allowed )) && [[ -d "$child" && ! -L "$child" ]]; then
      # Empty unknown directories are harmless drift: move them atomically to
      # a hidden quarantine beneath the same root so startup can proceed.
      if [[ -z "$(find "$child" -mindepth 1 -print -quit 2>/dev/null)" ]]; then
        quarantine_dir="$root/.quarantine"
        mkdir -p -- "$quarantine_dir"
        quarantine_target="$quarantine_dir/$name"
        if [[ -e "$quarantine_target" || -L "$quarantine_target" ]]; then
          quarantine_target="$quarantine_dir/${name}-$(date +%s%N)"
        fi
        if mv -- "$child" "$quarantine_target"; then
          echo "warning: quarantined unknown empty workspace directory: $child -> $quarantine_target" >&2
          continue
        fi
      fi
      echo "workspace drift: malformed or unknown workspace directory: $name" >&2; bad=1
    elif (( ! allowed )) || [[ ! -d "$child" || -L "$child" ]]; then
      echo "workspace drift: malformed or unknown workspace directory: $name" >&2; bad=1
    fi
  done < <(find "$root" -mindepth 1 -maxdepth 1 -print0)
  return "$bad"
}
workspace_root_create_workspace_dir() {
  local root="$1" workspace_id="$2" uuid
  for uuid in "${BELT_WORKSPACE_UUIDS[@]}"; do
    [[ "$workspace_id" == "$uuid" ]] && { mkdir -p -- "$root/$workspace_id"; return; }
  done
  echo "invalid workspace UUID: $workspace_id" >&2
  return 64
}
workspace_root_validate() {
  local root
  root="$(workspace_root_resolve)" || return
  if [[ "${BELT_TEST_MODE-0}" != 1 || "${BELT_WRAPPER_TEST-0}" != 1 ]]; then
    workspace_root_validate_children "$root" || return 64
  fi
  printf '%s\n' "$root"
}
