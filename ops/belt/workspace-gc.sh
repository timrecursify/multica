#!/usr/bin/env bash
set -euo pipefail
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./workspace-root.sh
source "$root_dir/workspace-root.sh"
apply=0
while (($#)); do case "$1" in --apply) apply=1;; --min-age-hours) shift;; *) exit 64;; esac; shift; done
root="$(workspace_root_resolve)"
limit="${WORKSPACE_GC_BATCH_LIMIT:-200}"
time_limit="${WORKSPACE_GC_TIME_LIMIT_SECONDS:-45}"
[[ "$limit" =~ ^[0-9]+$ && "$limit" -ge 1 ]] || exit 64
[[ "$time_limit" =~ ^[0-9]+$ && "$time_limit" -ge 1 ]] || exit 64
if [[ "${KEEP_WORKDIR:-}" == 1 ]]; then printf 'total\t0\t0\n'; exit 0; fi

descriptor_stream() {
  limit_eligible() {
    local descriptor task_id emitted=0
    while IFS= read -r descriptor; do
      task_id="${descriptor%%$'\t'*}"
      (( ${blocked_until[$task_id]:-0} > now )) && continue
      printf '%s\n' "$descriptor"
      emitted=$((emitted + 1))
      (( emitted >= limit )) && break
    done
  }
  if [[ -n "${WORKSPACE_GC_DESCRIPTOR_FILE:-}" ]]; then
    [[ "${BELT_TEST_MODE:-}" == 1 ]] || exit 64
    limit_eligible <"$WORKSPACE_GC_DESCRIPTOR_FILE"
    return
  fi
  local task_dir meta task_id values_sql='' separator='' missing_meta=0 sql_root
  declare -A seen_ids=()
  for task_dir in "$root"/*/????????; do
    [[ -d "$task_dir" && ! -L "$task_dir" ]] || continue
    workspace_name="$(basename -- "$(dirname -- "$task_dir")")"
    task_prefix="$(basename -- "$task_dir")"
    [[ "$workspace_name" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] || continue
    meta="$task_dir/.gc_meta.json"
    if [[ ! -f "$meta" ]]; then
      missing_meta=$((missing_meta + 1))
      continue
    fi
    task_id="$(jq -r '.task_id // empty' "$meta")"
    [[ "$task_id" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] || continue
    [[ "${task_id,,}" == "${task_prefix,,}"* ]] || continue
    [[ -z "${seen_ids["$task_id"]+x}" ]] || continue
    seen_ids["$task_id"]=1
    values_sql+="$separator('$task_id'::uuid)"
    separator=','
  done
  printf 'workspace-gc: skipped_missing_meta=%s\n' "$missing_meta" >&2
  [[ -n "$values_sql" ]] || return
  sql_root="${root//\'/\'\'}"
  docker exec gsp-multica-v2-postgres-1 psql -U gsp_multica -d gsp_multica -At -F $'\t' -c "
    WITH disk_task(id) AS (VALUES $values_sql)
    SELECT t.id, t.status, t.completed_at, t.issue_id,
           COALESCE(t.work_dir, '$sql_root/' || t.workspace_id || '/' || left(t.id::text, 8) || '/workdir')
    FROM agent_task_queue t JOIN disk_task d ON d.id = t.id
    WHERE t.status IN ('completed','failed','cancelled')
      AND t.completed_at < now() - interval '1 hour'
      AND (t.status <> 'completed' OR COALESCE(t.result->>'pr_url','') <> ''
           OR COALESCE(t.result->>'branch_name','') = '')
      AND NOT EXISTS (
        SELECT 1 FROM agent_task_queue live
        WHERE live.id <> t.id
          AND live.status NOT IN ('completed','failed','cancelled')
          AND live.issue_id = t.issue_id
          AND live.work_dir = COALESCE(t.work_dir, '$sql_root/' || t.workspace_id || '/' || left(t.id::text, 8) || '/workdir'))
      ORDER BY t.completed_at" | limit_eligible
}

state_dir="${WORKSPACE_GC_STATE_DIR:-$(dirname -- "$root")/gc-state}"
mkdir -p -- "$state_dir" 2>/dev/null || true
state_file="$state_dir/.gc-blocked.json"
now="$(date +%s)"
declare -A blocked_until=() blocked_failures=() blocked_first=()
if [[ -r "$state_file" ]] && jq -e '.tasks | type == "object" and all(.[]; (.retry_after | type == "number") and (.failures | type == "number") and (.first_blocked_at | type == "number"))' "$state_file" >/dev/null 2>&1; then
  while IFS=$'\t' read -r task_id retry_after failures first_blocked; do
    [[ -n "$task_id" && "$retry_after" =~ ^[0-9]+$ ]] || continue
    blocked_until["$task_id"]="$retry_after"
    blocked_failures["$task_id"]="${failures:-1}"
    blocked_first["$task_id"]="${first_blocked:-$now}"
  done < <(jq -r '.tasks | to_entries[] | [.key, (.value.retry_after // 0), (.value.failures // 1), (.value.first_blocked_at // 0)] | @tsv' "$state_file" 2>/dev/null || true)
fi
save_blocked() {
  local task_id="$1" failures="${blocked_failures[$1]:-0}" retry_after first_blocked tmp
  first_blocked="${blocked_first[$task_id]:-$now}"
  retry_after=$((now + (3600 << (failures > 5 ? 5 : failures))))
  ((retry_after > now + 86400)) && retry_after=$((now + 86400))
  blocked_until["$task_id"]="$retry_after"
  blocked_failures["$task_id"]=$((failures + 1))
  blocked_first["$task_id"]="$first_blocked"
  tmp="$(mktemp "$state_file.XXXXXX" 2>/dev/null)" || return 0
  if jq -n --argjson tasks "$(for id in "${!blocked_until[@]}"; do printf '%s\t%s\t%s\t%s\n' "$id" "${blocked_until[$id]}" "${blocked_failures[$id]}" "${blocked_first[$id]}"; done | jq -Rn '[inputs | split("\t") | {key: .[0], value: {retry_after: (.[1]|tonumber), failures: (.[2]|tonumber), first_blocked_at: (.[3]|tonumber)}}] | from_entries' 2>/dev/null)" '{tasks:$tasks}' >"$tmp" 2>/dev/null; then
    mv -f -- "$tmp" "$state_file" 2>/dev/null || rm -f -- "$tmp"
  else
    rm -f -- "$tmp"
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

if [[ "${BELT_TEST_MODE:-}" != 1 || "${WORKSPACE_GC_SKIP_BUSY_SCAN:-}" != 1 ]]; then
  for proc in /proc/[0-9]*; do
    [[ -d "$proc" ]] || continue
    record_busy_path "$proc/cwd"
    for fd in "$proc"/fd/*; do record_busy_path "$fd"; done
  done
fi

total=0; count=0
started_at="$(date +%s)"
while IFS=$'\t' read -r task_id status completed_at issue_id work_dir; do
  (( $(date +%s) - started_at >= time_limit )) && break
  [[ "$task_id" =~ ^[0-9a-fA-F-]{36}$ ]] || continue
  prefix="${task_id:0:8}"
  [[ "$work_dir" == "$root"/*/"$prefix"/workdir ]] || continue
  task_dir="${work_dir%/workdir}"
  [[ -d "$task_dir" && ! -L "$task_dir" ]] || continue
  [[ -z "${busy_task_dirs["$task_dir"]+x}" ]] || continue
  meta="$task_dir/.gc_meta.json"
  [[ -f "$meta" && "$(jq -r '.task_id // empty' "$meta")" == "$task_id" && "$(jq -r '.issue_id // empty' "$meta")" == "$issue_id" ]] || continue
  (( ${blocked_until[$task_id]:-0} > now )) && continue
  safe=1
  for checkout in "$work_dir" "$work_dir"/*; do
    [[ -d "$checkout/.git" || -f "$checkout/.git" ]] || continue
    status_output=""; status_rc=0
    status_output="$(timeout 10 git -C "$checkout" status --porcelain 2>/dev/null)" || status_rc=$?
    [[ "$status_rc" -eq 0 && -z "$status_output" ]] || { safe=0; break; }
    while IFS= read -r ref; do
      ref_sha="$(timeout 10 git -C "$checkout" rev-parse "$ref" 2>/dev/null)" || { safe=0; break 2; }
      [[ -n "$(timeout 10 git -C "$checkout" branch -r --contains "$ref_sha" 2>/dev/null)" ]] || { safe=0; break 2; }
    done < <(timeout 10 git -C "$checkout" for-each-ref --format='%(refname)' refs/heads refs/tags 2>/dev/null) || { safe=0; break; }
    while IFS= read -r stash_sha; do
      [[ -n "$(timeout 10 git -C "$checkout" branch -r --contains "$stash_sha" 2>/dev/null)" ]] || { safe=0; break 2; }
    done < <(timeout 10 git -C "$checkout" stash list --format='%H' 2>/dev/null) || { safe=0; break; }
  done
  if (( ! safe )); then save_blocked "$task_id"; continue; fi
  printf '%s\t%s\t%s\t%s\t%s\n' 0 "$task_id" "$status" "$completed_at" "$task_dir"
  count=$((count + 1))
  if ((apply)); then rm -rf --one-file-system -- "$task_dir"; fi
done < <(descriptor_stream)
printf 'total\t%s\t%s\n' "$count" "$total"
