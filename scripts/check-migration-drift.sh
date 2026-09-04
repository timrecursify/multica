#!/usr/bin/env bash
set -euo pipefail

# Read-only release-vs-database migration sentinel. DATABASE_URL must be
# supplied by the deploy environment; never hand-apply migration SQL.
cd "$(dirname "$0")/../server"
exec go run ./cmd/migrate audit
