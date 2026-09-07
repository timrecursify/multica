#!/bin/bash
# The scoper's note is only a specification if multica-bridge.cjs accepts it.
# latestSpecComment() matches on heading text, so the driver prompt and the gate
# must name the same headings or every scoped ticket re-queues and pays again.
set -euo pipefail
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
driver="$root_dir/scoping-claude-driver.sh"
bridge="$root_dir/multica-bridge.cjs"
fail=0

check() {
  if eval "$2"; then
    echo "ok - $1"
  else
    echo "not ok - $1"
    fail=1
  fi
}

# The headings the gate requires, read from the gate itself rather than restated.
gate_headings=$(grep -o "content LIKE '%## [A-Za-z]*%'" "$bridge" | grep -o '## [A-Za-z]*' | sort -u)
check "gate requires ## Spec and ## Evidence" \
  '[ "$(echo "$gate_headings" | tr "\n" ",")" = "## Evidence,## Spec," ]'

while read -r heading; do
  [ -n "$heading" ] || continue
  check "driver prompt instructs the model to emit '$heading'" \
    'grep -qF "$heading" "$driver"'
done <<<"$gate_headings"

check "driver passes the ticket description to the model" \
  'grep -q "Description: \${description}" "$driver"'
check "driver flattens newlines so the tab-separated row stays parsable" \
  'grep -q "regexp_replace(COALESCE(i.description" "$driver"'
check "driver is valid bash" 'bash -n "$driver"'

[ "$fail" -eq 0 ] && echo "PASS: scoping driver satisfies the bridge spec gate"
exit "$fail"
