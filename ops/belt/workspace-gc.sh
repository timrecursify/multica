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
  docker exec gsp-multica-v2-postgres-1 psql -U gsp_multica -d gsp_multica -At -F $'\t' -v batch_limit="$limit" -c "
    SELECT t.id, t.status, t.completed_at, t.issue_id,
           COALESCE(t.work_dir, '$root/' || t.workspace_id || '/' || left(t.id::text, 8) || '/workdir')
    FROM agent_task_queue t
    WHERE t.status IN ('completed','failed','cancelled')
      AND t.completed_at < now() - interval '1 hour'
      AND (t.status <> 'completed' OR COALESCE(t.result->>'pr_url','') <> ''
           OR COALESCE(t.result->>'branch_name','') = '')
      AND NOT EXISTS (
        SELECT 1 FROM agent_task_queue live
        WHERE live.id <> t.id
          AND live.status NOT IN ('completed','failed','cancelled')
          AND live.issue_id = t.issue_id
          AND live.work_dir = COALESCE(t.work_dir, '$root/' || t.workspace_id || '/' || left(t.id::text, 8) || '/workdir'))
      ORDER BY t.completed_at LIMIT :batch_limit"
}

total=0; count=0
while IFS=$'\t' read -r task_id status completed_at issue_id work_dir; do
  [[ "$task_id" =~ ^[0-9a-fA-F-]{36}$ ]] || continue
  prefix="${task_id:0:8}"
  [[ "$work_dir" == "$root"/*/"$prefix"/workdir ]] || continue
  task_dir="${work_dir%/workdir}"
  [[ -d "$task_dir" && ! -L "$task_dir" ]] || continue
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
