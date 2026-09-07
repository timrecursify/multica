#!/usr/bin/env bash
set -euo pipefail
dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
fixture="$(mktemp -d -p "$dir" workspace-gc-test.XXXXXXXX)"
gcroot="$fixture/root"
workspace=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa; task=12345678-1234-1234-1234-123456789abc
issue=aaaaaaaa-1234-1234-1234-123456789abc
mkdir -p "$fixture/bin" "$fixture/remote.git" "$gcroot/$workspace/${task:0:8}" "$gcroot/$workspace/deadbeef"
git -C "$fixture/remote.git" init --bare -q
git clone -q "$fixture/remote.git" "$gcroot/$workspace/${task:0:8}/workdir"
git -C "$gcroot/$workspace/${task:0:8}/workdir" config user.email gc@example.test
git -C "$gcroot/$workspace/${task:0:8}/workdir" config user.name GC
touch "$gcroot/$workspace/${task:0:8}/workdir/tracked"
git -C "$gcroot/$workspace/${task:0:8}/workdir" add tracked
git -C "$gcroot/$workspace/${task:0:8}/workdir" commit -qm initial
git -C "$gcroot/$workspace/${task:0:8}/workdir" push -qu origin HEAD:main
git -C "$gcroot/$workspace/${task:0:8}/workdir" fetch -q origin
printf '{"task_id":"%s","issue_id":"%s"}\n' "$task" "$issue" > "$gcroot/$workspace/${task:0:8}/.gc_meta.json"
printf '%s\tcompleted\t2026-01-01T00:00:00Z\t%s\t%s\n' "$task" "$issue" "$gcroot/$workspace/${task:0:8}/workdir" > "$fixture/descriptors"
descriptor="$(<"$fixture/descriptors")"

printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\n" "$*" > "$FAKE_DOCKER_ARGS"' 'printf "%s\n" "$FAKE_DESCRIPTOR"' > "$fixture/bin/docker"
chmod +x "$fixture/bin/docker"

disk_out="$(PATH="$fixture/bin:$PATH" FAKE_DOCKER_ARGS="$fixture/docker.args" FAKE_DESCRIPTOR="$descriptor"$'\n'"$descriptor" WORKSPACE_GC_BATCH_LIMIT=1 BELT_TEST_MODE=1 BELT_WORKSPACES_ROOT_OVERRIDE="$gcroot" "$dir/workspace-gc.sh" 2>"$fixture/disk.err")"
[[ "$(grep -c "$task" <<<"$disk_out")" == 1 ]]
grep -q "$task" "$fixture/docker.args"
grep -q 'WITH disk_task(id) AS (VALUES' "$fixture/docker.args"
! grep -q ':batch_limit' "$fixture/docker.args"
grep -q 'skipped_missing_meta=1' "$fixture/disk.err"
[[ "$(tr -cd '(' < "$fixture/docker.args" | wc -c)" == "$(tr -cd ')' < "$fixture/docker.args" | wc -c)" ]]

sleep 30 < "$gcroot/$workspace/${task:0:8}/workdir/tracked" & busy_pid=$!
busy_out="$(BELT_TEST_MODE=1 BELT_WORKSPACES_ROOT_OVERRIDE="$gcroot" WORKSPACE_GC_DESCRIPTOR_FILE="$fixture/descriptors" "$dir/workspace-gc.sh")"
! grep -q "$task" <<<"$busy_out"
kill "$busy_pid"; wait "$busy_pid" 2>/dev/null || :
out="$(BELT_TEST_MODE=1 BELT_WORKSPACES_ROOT_OVERRIDE="$gcroot" WORKSPACE_GC_DESCRIPTOR_FILE="$fixture/descriptors" "$dir/workspace-gc.sh")"
grep -q "$task" <<<"$out"
echo 'workspace gc regression passed'
