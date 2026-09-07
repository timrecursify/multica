#!/usr/bin/env bash
set -euo pipefail
dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"; fixture="$(mktemp -d)"; trap 'kill "$pid" 2>/dev/null || :; rm -rf "$fixture"' EXIT
mkdir -p "$fixture/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"/{old12345,new12345,busy12345}; touch -d '3 hours ago' "$fixture/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"/{old12345,busy12345}; touch "$fixture/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/new12345"
(cd "$fixture/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/busy12345"; sleep 30) & pid=$!
out="$(BELT_TEST_MODE=1 BELT_WORKSPACES_ROOT_OVERRIDE="$fixture" "$dir/workspace-gc.sh")"; grep -q old12345 <<<"$out"; ! grep -qE 'new12345|busy12345' <<<"$out"; WORKSPACE_GC_STATE_DIR="$fixture/state" BELT_TEST_MODE=1 BELT_WORKSPACES_ROOT_OVERRIDE="$fixture" "$dir/workspace-gc.sh" --apply >/dev/null; [[ ! -d "$fixture/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/old12345" ]]; [[ -d "$fixture/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/busy12345" ]]; echo 'workspace gc regression passed'
