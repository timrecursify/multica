#!/bin/bash
set -euo pipefail

# Deterministic QC gate runs before model QC on In Progress -> In Review.
export QC_GATE_ENABLED="${QC_GATE_ENABLED:-1}"
export QC_ESCALATE_ENABLED="${QC_ESCALATE_ENABLED:-1}"
export QC_ESCALATE_MODEL="${QC_ESCALATE_MODEL:-gpt-5.6-luna}"
export MULTICA_MODEL=gpt-5.6-luna
export MULTICA_PROVIDER=openai
export QC_GATE_PENDING_RECHECK_MS="${QC_GATE_PENDING_RECHECK_MS:-300000}"
export QC_GATE_CI_ADVISORY="${QC_GATE_CI_ADVISORY:-1}"
export QC_GATE_GH_COOLDOWN_MS="${QC_GATE_GH_COOLDOWN_MS:-600000}"

exec /usr/bin/node /opt/gsp/multica-workers/multica-relay-advance/app/parity/multica-relay-advance-launcher.cjs
