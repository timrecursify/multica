#!/usr/bin/env bash
set -euo pipefail
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
fixture="$(mktemp -d)"
mkdir -p "$fixture/da3c5c5c-a123-4567-b999-c3ed1820da00" \
  "$fixture/f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f"
BELT_TEST_MODE=1 BELT_WORKSPACES_ROOT_OVERRIDE="$fixture" \
  bash -c 'source "$1/workspace-root.sh"; [[ "$(workspace_root_validate)" == "$2" ]]' _ "$root_dir" "$fixture"
mkdir "$fixture/ f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f"
touch "$fixture/ f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f/state"
if BELT_TEST_MODE=1 BELT_WORKSPACES_ROOT_OVERRIDE="$fixture" \
  bash -c 'source "$1/workspace-root.sh"; workspace_root_validate' _ "$root_dir" 2>"$fixture/error"; then
  echo 'malformed child unexpectedly accepted' >&2; exit 1
fi
grep -q 'malformed or unknown workspace directory:  f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f' "$fixture/error"
rm -rf -- "$fixture/ f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f"
mkdir "$fixture/unknown-empty"
if ! BELT_TEST_MODE=1 BELT_WRAPPER_TEST=0 BELT_WORKSPACES_ROOT_OVERRIDE="$fixture" \
  bash -c 'source "$1/workspace-root.sh"; workspace_root_validate' _ "$root_dir" 2>"$fixture/quarantine-error"; then
  echo 'empty unknown child unexpectedly rejected' >&2; exit 1
fi
[[ ! -e "$fixture/unknown-empty" ]]
quarantined=("$fixture"/.quarantine/unknown-empty)
[[ -d "${quarantined[0]}" ]]
grep -q 'quarantined unknown empty workspace directory' "$fixture/quarantine-error"
mkdir "$fixture/unknown-nonempty"
touch "$fixture/unknown-nonempty/state"
if BELT_TEST_MODE=1 BELT_WRAPPER_TEST=0 BELT_WORKSPACES_ROOT_OVERRIDE="$fixture" \
  bash -c 'source "$1/workspace-root.sh"; workspace_root_validate' _ "$root_dir" 2>"$fixture/nonempty-error"; then
  echo 'non-empty unknown child unexpectedly accepted' >&2; exit 1
fi
grep -q 'malformed or unknown workspace directory: unknown-nonempty' "$fixture/nonempty-error"
if BELT_TEST_MODE=1 BELT_WRAPPER_TEST=0 BELT_WORKSPACES_ROOT_OVERRIDE="$fixture" \
  bash -c 'source "$1/workspace-root.sh"; workspace_root_create_workspace_dir "$2" bad-uuid' _ "$root_dir" "$fixture"; then
  echo 'malformed workspace UUID unexpectedly accepted' >&2; exit 1
fi
[[ ! -e "$fixture/bad-uuid" ]]
if MULTICA_DAEMON_WORKSPACES_ROOT="$fixture" MULTICA_WORKSPACES_ROOT=/different \
  bash -c 'source "$1/workspace-root.sh"; workspace_root_validate' _ "$root_dir" 2>"$fixture/disagreement"; then
  echo 'root disagreement unexpectedly accepted' >&2; exit 1
fi
grep -q 'roots disagree' "$fixture/disagreement"
echo 'workspace root regression passed'
