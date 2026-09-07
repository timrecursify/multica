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

make_candidate() {
  local candidate="$1" mode="$2" candidate_dir
  candidate_dir="$gcroot/$workspace/${candidate:0:8}"
  mkdir -p "$candidate_dir"
  cp -a "$gcroot/$workspace/${task:0:8}/workdir" "$candidate_dir/workdir"
  git -C "$candidate_dir/workdir" config user.email gc@example.test
  git -C "$candidate_dir/workdir" config user.name GC
  case "$mode" in
    dirty) printf dirty >"$candidate_dir/workdir/untracked" ;;
    local) git -C "$candidate_dir/workdir" checkout -qb local-only; printf local >>"$candidate_dir/workdir/tracked"; git -C "$candidate_dir/workdir" commit -qam local-only ;;
    stash) printf stash >>"$candidate_dir/workdir/tracked"; git -C "$candidate_dir/workdir" stash push -qm stash-only ;;
  esac
  printf '{"task_id":"%s","issue_id":"%s"}\n' "$candidate" "$issue" >"$candidate_dir/.gc_meta.json"
}

blocked=22345678-1234-1234-1234-123456789abc
clean=32345678-1234-1234-1234-123456789abc
local=42345678-1234-1234-1234-123456789abc
stash=52345678-1234-1234-1234-123456789abc
statusfail=62345678-1234-1234-1234-123456789abc
make_candidate "$blocked" dirty
make_candidate "$clean" clean
make_candidate "$local" local
make_candidate "$stash" stash
make_candidate "$statusfail" clean
printf '%s\n' \
  "$blocked"$'\tcompleted\t2026-01-01T00:00:00Z\t'"$issue"$'\t'"$gcroot/$workspace/${blocked:0:8}/workdir" \
  "$clean"$'\tcompleted\t2026-01-01T00:00:01Z\t'"$issue"$'\t'"$gcroot/$workspace/${clean:0:8}/workdir" \
  "$local"$'\tcompleted\t2026-01-01T00:00:02Z\t'"$issue"$'\t'"$gcroot/$workspace/${local:0:8}/workdir" \
  "$stash"$'\tcompleted\t2026-01-01T00:00:03Z\t'"$issue"$'\t'"$gcroot/$workspace/${stash:0:8}/workdir" \
  "$statusfail"$'\tcompleted\t2026-01-01T00:00:04Z\t'"$issue"$'\t'"$gcroot/$workspace/${statusfail:0:8}/workdir" >"$fixture/descriptors"
real_git="$(command -v git)"
printf '%s\n' '#!/usr/bin/env bash' 'case " $* " in *62345678*" status "*) exit 42;; esac' 'exec "$REAL_GIT" "$@"' >"$fixture/bin/git"
chmod +x "$fixture/bin/git"
PATH="$fixture/bin:$PATH" REAL_GIT="$real_git" BELT_TEST_MODE=1 WORKSPACE_GC_SKIP_BUSY_SCAN=1 BELT_WORKSPACES_ROOT_OVERRIDE="$gcroot" WORKSPACE_GC_DESCRIPTOR_FILE="$fixture/descriptors" "$dir/workspace-gc.sh" >"$fixture/status-failure.out"
! grep -q "$statusfail" "$fixture/status-failure.out"
rm "$fixture/bin/git"
PATH="$fixture/bin:$PATH" BELT_TEST_MODE=1 WORKSPACE_GC_SKIP_BUSY_SCAN=1 BELT_WORKSPACES_ROOT_OVERRIDE="$gcroot" WORKSPACE_GC_DESCRIPTOR_FILE="$fixture/descriptors" WORKSPACE_GC_TIME_LIMIT_SECONDS=30 "$dir/workspace-gc.sh" >"$fixture/first.out"
grep -q "$clean" "$fixture/first.out"
! grep -q "$blocked\|$local\|$stash" "$fixture/first.out"
jq -e --arg id "$blocked" '.tasks[$id].retry_after > 0' "$gcroot/.gc-blocked.json" >/dev/null
PATH="$fixture/bin:$PATH" BELT_TEST_MODE=1 WORKSPACE_GC_SKIP_BUSY_SCAN=1 BELT_WORKSPACES_ROOT_OVERRIDE="$gcroot" WORKSPACE_GC_DESCRIPTOR_FILE="$fixture/descriptors" "$dir/workspace-gc.sh" >"$fixture/second.out"
grep -q "$clean" "$fixture/second.out"
! grep -q "$blocked" "$fixture/second.out"
jq --arg id "$blocked" '.tasks[$id].retry_after = 0' "$gcroot/.gc-blocked.json" >"$fixture/state.tmp" && mv "$fixture/state.tmp" "$gcroot/.gc-blocked.json"
PATH="$fixture/bin:$PATH" BELT_TEST_MODE=1 WORKSPACE_GC_SKIP_BUSY_SCAN=1 BELT_WORKSPACES_ROOT_OVERRIDE="$gcroot" WORKSPACE_GC_DESCRIPTOR_FILE="$fixture/descriptors" "$dir/workspace-gc.sh" >"$fixture/retry.out"
! grep -q "$blocked\|$local\|$stash" "$fixture/retry.out"
printf '{broken' >"$gcroot/.gc-blocked.json"
PATH="$fixture/bin:$PATH" BELT_TEST_MODE=1 WORKSPACE_GC_SKIP_BUSY_SCAN=1 BELT_WORKSPACES_ROOT_OVERRIDE="$gcroot" WORKSPACE_GC_DESCRIPTOR_FILE="$fixture/descriptors" "$dir/workspace-gc.sh" >"$fixture/corrupt.out"
grep -q "$clean" "$fixture/corrupt.out"

du_fail="$fixture/bin/du"
printf '%s\n' '#!/usr/bin/env bash' 'exit 99' >"$du_fail"
chmod +x "$du_fail"
PATH="$fixture/bin:$PATH" BELT_TEST_MODE=1 WORKSPACE_GC_SKIP_BUSY_SCAN=1 BELT_WORKSPACES_ROOT_OVERRIDE="$gcroot" WORKSPACE_GC_DESCRIPTOR_FILE="$fixture/descriptors" "$dir/workspace-gc.sh" >"$fixture/no-du.out"
grep -q "$clean" "$fixture/no-du.out"
echo 'workspace gc regression passed'
