#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
release="$tmp/release"; runtime="$tmp/runtime"
mkdir -p "$release/ops/belt" "$runtime"
set +e
"$root/install-bundle-helper.sh" "$release" "$runtime" 2>"$tmp/e"
rc=$?
set -e
[[ $rc -ne 0 && $(<"$tmp/e") == missing\ helper\ source:* && ! -e "$runtime/multica-bundle.py" ]]
printf '%s\n' '#!/usr/bin/env python3' 'print("ok")' > "$release/ops/belt/multica-bundle.py"
set +e
"$root/install-bundle-helper.sh" "$release" "$runtime" 2>"$tmp/e"
rc=$?
set -e
[[ $rc -ne 0 && $(<"$tmp/e") == non-executable\ helper\ source:* && ! -e "$runtime/multica-bundle.py" ]]
chmod 0555 "$release/ops/belt/multica-bundle.py"
"$root/install-bundle-helper.sh" "$release" "$runtime"
[[ -x "$runtime/multica-bundle.py" ]]
cmp "$release/ops/belt/multica-bundle.py" "$runtime/multica-bundle.py"
(cd "$tmp" && "$runtime/multica-bundle.py" | grep -qx ok)
echo 'install-bundle-helper: missing/non-executable/success passed'
