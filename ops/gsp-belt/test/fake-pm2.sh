#!/bin/bash
# Minimal fake pm2 for bdeploy-tool tests. State kept in $FAKE_PM2_STATE JSON.
# startOrReload: re-parses rendered ecosystem `script:` values and updates each
#   app's pm_exec_path; if FAKE_FAIL_ONCE=1 the FIRST mutation marks all apps
#   'errored' (simulating reload/health failure), consumed in one shot so the
#   subsequent rollback reload succeeds.
set -euo pipefail
state_file="${FAKE_PM2_STATE:?FAKE_PM2_STATE required}"
fail_flag="${FAKE_FAIL_FLAG:-}"

init() {
  cat > "$state_file" <<'JS'
[
 {"name":"gsp-multica-bridge","pm2_env":{"name":"gsp-multica-bridge","pm_exec_path":"/old/bridge.cjs","status":"online"}},
 {"name":"gsp-multica-worker","pm2_env":{"name":"gsp-multica-worker","pm_exec_path":"/old/wrapper.sh","status":"online"}},
 {"name":"multica-cicd-worker","pm2_env":{"name":"multica-cicd-worker","pm_exec_path":"/old/cicd.cjs","status":"online"}},
 {"name":"multica-archiver","pm2_env":{"name":"multica-archiver","pm_exec_path":"/old/archiver.cjs","status":"online"}},
 {"name":"multica-relay-advance","pm2_env":{"name":"multica-relay-advance","pm_exec_path":"/old/relay.sh","status":"online"}}
]
JS
}
[[ -f "$state_file" ]] || init

cmd="${1:-}"
case "$cmd" in
  jlist) cat "$state_file";;
  startOrReload)
    eco="${2:?eco path required}"
    python3 - "$eco" "$state_file" "$fail_flag" <<'PY'
import json,sys,re,os
eco, state_file, fail_flag = sys.argv[1], sys.argv[2], sys.argv[3]
consumed = fail_flag and os.path.exists(fail_flag)
src = open(eco).read()
apps = json.load(open(state_file))
for a in apps:
    m = re.search(r"name:\s*'"+re.escape(a['name'])+r"'.*?script:\s*'([^']+)'", src, re.S)
    if m: a['pm2_env']['pm_exec_path'] = m.group(1)
if fail_flag and not consumed:
    for a in apps: a['pm2_env']['status'] = 'errored'
    open(fail_flag,'w').write('consumed')
else:
    for a in apps: a['pm2_env']['status'] = 'online'
json.dump(apps, open(state_file,'w'))
PY
    echo "startOrReload $(basename "$eco")"
    ;;
  reload)
    python3 - "$state_file" "$fail_flag" <<'PY'
import json,sys,os
state, fail_flag = sys.argv[1], sys.argv[2]
apps = json.load(open(state))
for a in apps:
    a['pm2_env']['status'] = 'online'
json.dump(apps, open(state,'w'))
PY
    echo "reload all"
    ;;
  *) echo "unknown: $cmd" >&2; exit 2;;
esac
