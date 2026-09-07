#!/usr/bin/env bash
set -euo pipefail
dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"; fixture="$(mktemp -d)"; trap 'rm -rf "$fixture"' EXIT
workspace=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa; task=12345678-1234-1234-1234-123456789abc
mkdir -p "$fixture/remote.git" "$fixture/$workspace/${task:0:8}"
git -C "$fixture/remote.git" init --bare -q
git clone -q "$fixture/remote.git" "$fixture/$workspace/${task:0:8}/workdir"
git -C "$fixture/$workspace/${task:0:8}/workdir" config user.email gc@example.test
git -C "$fixture/$workspace/${task:0:8}/workdir" config user.name GC
touch "$fixture/$workspace/${task:0:8}/workdir/tracked"
git -C "$fixture/$workspace/${task:0:8}/workdir" add tracked
git -C "$fixture/$workspace/${task:0:8}/workdir" commit -qm initial
git -C "$fixture/$workspace/${task:0:8}/workdir" push -qu origin HEAD:main
git -C "$fixture/$workspace/${task:0:8}/workdir" fetch -q origin
printf '%s\tcompleted\t2026-01-01T00:00:00Z\t%s\n' "$task" "$fixture/$workspace/${task:0:8}/workdir" > "$fixture/descriptors"
out="$(BELT_TEST_MODE=1 BELT_WORKSPACES_ROOT_OVERRIDE="$fixture" WORKSPACE_GC_DESCRIPTOR_FILE="$fixture/descriptors" "$dir/workspace-gc.sh")"
grep -q "$task" <<<"$out"
BELT_TEST_MODE=1 BELT_WORKSPACES_ROOT_OVERRIDE="$fixture" WORKSPACE_GC_DESCRIPTOR_FILE="$fixture/descriptors" "$dir/workspace-gc.sh" --apply >/dev/null
[[ ! -d "$fixture/$workspace/${task:0:8}" ]]
echo 'workspace gc regression passed'
