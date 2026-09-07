#!/usr/bin/env bash
set -Eeuo pipefail
units=(gsp-multica-bridge multica-relay-advance multica-archiver multica-cicd-worker gsp-multica-worker gsp-multica-worker-ppp)
check=0
[[ "${1:-}" == --check ]] && check=1
bad=0
for unit in "${units[@]}"; do
  systemctl is-enabled --quiet "$unit.service" || continue
  state="$(systemctl is-active "$unit.service" 2>/dev/null || true)"
  [[ "$state" == active || "$state" == activating ]] && continue
  inactive_since="$(systemctl show "$unit.service" -p InactiveEnterTimestamp --value)"
  [[ -n "$inactive_since" ]] || inactive_since="unknown"
  sudo_line="$(journalctl _COMM=sudo --since "$inactive_since" --no-pager 2>/dev/null | grep -E "systemctl (stop|restart) ${unit}(\.service)?" | tail -n 1 || true)"
  [[ -n "$sudo_line" ]] || sudo_line="not found"
  logger -t belt-unit-guard "unit=$unit state=$state inactive_since=$inactive_since last_stop=$sudo_line"
  if ((check)); then printf 'would-start unit=%s state=%s inactive_since=%s last_stop=%s\n' "$unit" "$state" "$inactive_since" "$sudo_line"; bad=1; else systemctl start "$unit.service"; fi
done
if ((bad == 0)); then logger -t belt-unit-guard 'all units active'; printf '%s\n' 'all units active'; fi
exit "$bad"
