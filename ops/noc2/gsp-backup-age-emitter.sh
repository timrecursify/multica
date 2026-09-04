#!/usr/bin/env bash
set -u

CONFIG=${GSP_BACKUP_LANES_CONFIG:-/etc/gsp/backup-lanes.conf}
QUERY=${GSP_BACKUP_AGE_QUERY:-/usr/local/bin/gsp-backup-age}

escape() { sed 's/\\/\\\\/g; s/"/\\"/g'; }
metric_name() { printf '%s' "$1" | tr -c 'A-Za-z0-9_' '_'; }

if [[ ! -r $CONFIG ]]; then
  printf '# backup-lanes.conf is unavailable\n'
  exit 0
fi
# The config is an env-style, root-owned file. Do not execute command
# substitutions: only assignments matching the documented names are loaded.
while IFS='=' read -r key value; do
  [[ $key =~ ^(LANES|LANE_[A-Za-z0-9_]+_(REPOSITORY|ENV_FILE))$ ]] || continue
  value=$(printf '%s' "$value" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
  printf -v "$key" '%s' "$value"
done < <(sed -n 's/[[:space:]]*#.*$//; /^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/p' "$CONFIG")

for lane in ${LANES-}; do
  id=$(metric_name "$lane")
  eval "repository=\${LANE_${lane}_REPOSITORY-}" 2>/dev/null || repository=
  eval "env_file=\${LANE_${lane}_ENV_FILE-}" 2>/dev/null || env_file=
  ok=0; age=
  if [[ -n $repository && -x $QUERY ]]; then
    # Repository is always passed explicitly; credentials are supplied by the
    # referenced env file by the query helper and never printed here.
    if [[ -r $env_file ]]; then
      age=$($QUERY --repository "$repository" --env-file "$env_file" 2>/dev/null) || age=
    else
      age=$($QUERY --repository "$repository" 2>/dev/null) || age=
    fi
    [[ $age =~ ^[0-9]+([.][0-9]+)?$ ]] && ok=1 || age=0
  else
    age=0
  fi
  printf 'backup_lane_age_seconds{lane="%s"} %s\n' "$(printf '%s' "$lane" | escape)" "$age"
  printf 'backup_lane_query_ok{lane="%s"} %d\n' "$(printf '%s' "$lane" | escape)" "$ok"
done
exit 0
