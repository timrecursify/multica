#!/usr/bin/env bash
set -euo pipefail
selector=${SK_TEST_SELECTOR:-'TestIssueCRUD|TestGitHubWebhook'}
if [[ -x .sk/toolchains/go1.26.1/bin/go ]]; then go_bin=.sk/toolchains/go1.26.1/bin/go
elif [[ -x /usr/local/go/bin/go ]]; then go_bin=/usr/local/go/bin/go
else echo 'Go 1.26.1 toolchain unavailable; provision .sk/toolchains/go1.26.1' >&2; exit 127; fi
exec "$go_bin" test ./internal/handler -run "$selector" -count=1
