#!/usr/bin/env bash
set -euo pipefail
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$root_dir/workspace-root.sh"
min_age=2; apply=0
while (($#)); do case "$1" in --apply) apply=1;; --min-age-hours) min_age="$2"; shift;; *) exit 64;; esac; shift; done
root="$(workspace_root_resolve)"; cutoff=$(( $(date +%s) - min_age * 3600 )); total=0; paths=(); bytes=()
while IFS= read -r -d '' task; do
  [[ -d "$task" && ! -L "$task" ]] || continue; (( $(stat -c %Y -- "$task") < cutoff )) || continue; busy=0
  for proc in /proc/[0-9]*; do
    [[ "$(readlink -e -- "$proc/cwd" 2>/dev/null || :)" == "$task" ]] && { busy=1; break; }
    for fd in "$proc"/fd/*; do [[ "$(readlink -e -- "$fd" 2>/dev/null || :)" == "$task"/* ]] && { busy=1; break 2; }; done
  done
  (( busy == 0 )) || continue; size="$(du -sb -- "$task" | awk '{print $1}')"; paths+=("$task"); bytes+=("$size"); total=$((total + size)); printf '%s %s\n' "$task" "$size"
done < <(find "$root" -mindepth 2 -maxdepth 2 -type d -name '????????' -print0)
printf 'total %s\n' "$total"
if (( apply )); then state="${WORKSPACE_GC_STATE_DIR-/var/lib/gsp-multica/state}"; ts="$(date -u +%Y%m%dT%H%M%SZ)"; mkdir -p "$state"; receipt="$state/workspace-gc-$ts.txt"; : > "$receipt"; for i in "${!paths[@]}"; do printf '%s %s %s\n' "$ts" "${paths[$i]}" "${bytes[$i]}" >> "$receipt"; rm -rf -- "${paths[$i]}"; done; printf '%s total %s\n' "$ts" "$total" >> "$receipt"; fi
