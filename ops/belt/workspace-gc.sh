#!/usr/bin/env bash
set -euo pipefail
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$root_dir/workspace-root.sh"
apply=0
while (($#)); do case "$1" in --apply) apply=1;; --min-age-hours) shift;; *) exit 64;; esac; shift; done
root="$(workspace_root_resolve)"
limit="${WORKSPACE_GC_BATCH_LIMIT:-200}"
[[ "$limit" =~ ^[0-9]+$ && "$limit" -ge 1 && "$limit" -le 200 ]] || exit 64
if [[ "${KEEP_WORKDIR:-}" == 1 ]]; then printf 'total\t0\t0\n'; exit 0; fi

descriptor_stream() {
  if [[ -n "${WORKSPACE_GC_DESCRIPTOR_FILE:-}" ]]; then
    [[ "${BELT_TEST_MODE:-}" == 1 ]] || exit 64
    head -n "$limit" -- "$WORKSPACE_GC_DESCRIPTOR_FILE"
    return
  fi
  local ids=() dir meta id prefix workspace
  shopt -s nullglob
  for workspace_dir in "$root"/*; do
    [[ -d "$workspace_dir" && ! -L "$workspace_dir" ]] || continue
    workspace="${workspace_dir##*/}"
    for dir in "$workspace_dir"/*; do
      [[ -d "$dir" && ! -L "$dir" ]] || continue
      prefix="${dir##*/}"
      [[ "$prefix" =~ ^[0-9a-fA-F]{8}$ ]] || continue
      meta="$dir/.gc_meta.json"
      [[ -f "$meta" && ! -L "$meta" ]] || continue
      id="$(jq -r '.task_id // empty' "$meta" 2>/dev/null || :)"
      [[ "$id" =~ ^[0-9a-fA-F-]{36}$ && "${id:0:8}" == "$prefix" ]] || continue
      ids+=("$id")
    done
  done
  shopt -u nullglob
  ((${#ids[@]})) || return 0
  mapfile -t ids < <(printf '%s\n' "${ids[@]}" | sort -u)
  local in_list=""
  for id in "${ids[@]}"; do
    if [[ -n "$in_list" ]]; then in_list+=","; fi
    in_list+="'$id'::uuid"
  done
  local query="
    SELECT t.id, t.status, t.completed_at, t.issue_id,
           COALESCE(t.work_dir, '$root/' || t.workspace_id || '/' || left(t.id::text, 8) || '/workdir')
    FROM agent_task_queue t
    WHERE t.id IN ($in_list)
      AND t.status IN ('completed','failed','cancelled')
      AND t.completed_at < now() - interval '1 hour'
      AND (t.status <> 'completed' OR COALESCE(t.result->>'pr_url','') <> ''
           OR COALESCE(t.result->>'branch_name','') = '')
      AND NOT EXISTS (
        SELECT 1 FROM agent_task_queue live
        WHERE live.id <> t.id
          AND live.status NOT IN ('completed','failed','cancelled')
          AND live.issue_id = t.issue_id
          AND live.work_dir = COALESCE(t.work_dir, '$root/' || t.workspace_id || '/' || left(t.id::text, 8) || '/workdir'))
      ORDER BY t.completed_at"
  if [[ -n "${WORKSPACE_GC_PSQL_COMMAND:-}" ]]; then
    eval "$WORKSPACE_GC_PSQL_COMMAND" <<<"$query"
  else
    docker exec gsp-multica-v2-postgres-1 psql -U gsp_multica -d gsp_multica -At -F $'\t' -c "$query"
  fi
}

declare -A busy_task_dirs=()
record_busy_path() {
  local link="$1" path relative workspace remainder task
  path="$(readlink -e -- "$link" 2>/dev/null)" || return 0
  [[ "$path" == "$root"/* ]] || return 0
  relative="${path#"$root"/}"
  [[ "$relative" == */* ]] || return 0
  workspace="${relative%%/*}"
  remainder="${relative#*/}"
  task="${remainder%%/*}"
  [[ -n "$workspace" && -n "$task" ]] || return 0
  busy_task_dirs["$root/$workspace/$task"]=1
}

for proc in /proc/[0-9]*; do
  [[ -d "$proc" ]] || continue
  record_busy_path "$proc/cwd"
  for fd in "$proc"/fd/*; do record_busy_path "$fd"; done
done

total=0; count=0
while IFS=$'\t' read -r task_id status completed_at issue_id work_dir; do
  ((count < limit)) || break
  [[ "$task_id" =~ ^[0-9a-fA-F-]{36}$ ]] || continue
  prefix="${task_id:0:8}"
  [[ "$work_dir" == "$root"/*/"$prefix"/workdir ]] || continue
  task_dir="${work_dir%/workdir}"
  [[ -d "$task_dir" && ! -L "$task_dir" ]] || continue
  [[ -z "${busy_task_dirs["$task_dir"]+x}" ]] || continue
  meta="$task_dir/.gc_meta.json"
  [[ -f "$meta" && "$(jq -r '.task_id // empty' "$meta")" == "$task_id" && "$(jq -r '.issue_id // empty' "$meta")" == "$issue_id" ]] || continue
  safe=1
  for checkout in "$work_dir" "$work_dir"/*; do
    [[ -d "$checkout/.git" || -f "$checkout/.git" ]] || continue
    [[ -z "$(git -C "$checkout" status --porcelain 2>/dev/null | head -1)" ]] || { safe=0; break; }
    head_sha="$(git -C "$checkout" rev-parse HEAD 2>/dev/null || :)"
    [[ -n "$head_sha" && -n "$(git -C "$checkout" branch -r --contains "$head_sha" 2>/dev/null | head -1)" ]] || { safe=0; break; }
  done
  ((safe)) || continue
  size="$(du -sb -- "$task_dir" | awk '{print $1}')"
  printf '%s\t%s\t%s\t%s\t%s\n' "$size" "$task_id" "$status" "$completed_at" "$task_dir"
  total=$((total + size)); count=$((count + 1))
  if ((apply)); then rm -rf --one-file-system -- "$task_dir"; fi
done < <(descriptor_stream)
printf 'total\t%s\t%s\n' "$count" "$total"
