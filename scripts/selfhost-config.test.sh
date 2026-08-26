#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

require_config() {
  local config=$1
  local expected=$2

  if ! grep -Fq "$expected" <<<"$config"; then
    echo "Missing expected docker compose config value:"
    echo "  $expected"
    exit 1
  fi
}

require_env() {
  local output=$1
  local expected=$2

  if ! grep -Fxq "$expected" <<<"$output"; then
    echo "Missing expected derived env value:"
    echo "  $expected"
    echo "Observed:"
    echo "$output"
    exit 1
  fi
}

pass() {
  echo "PASS: $1"
}

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

tmp_env="$(mktemp)"
tmp_dir="$(mktemp -d)"
trap 'rm -f "$tmp_env"; rm -rf "$tmp_dir"' EXIT
sed 's/^FRONTEND_PORT=.*/FRONTEND_PORT=3100/' .env.example >"$tmp_env"
printf '\nBACKEND_PORT=9100\n' >>"$tmp_env"

# Throwaway checkout so tests never touch this repo's own .env.
recipe_dir="$tmp_dir/recipe"
mkdir -p "$recipe_dir/scripts"
cp Makefile .env.example docker-compose.selfhost.yml docker-compose.selfhost.build.yml "$recipe_dir/"
cp scripts/selfhost-wait.sh scripts/selfhost-compose.sh "$recipe_dir/scripts/"

# (Re)write recipe_dir/.env from .env.example, optionally applying a sed script.
make_env() {
  local mutation=${1:-}

  cp "$recipe_dir/.env.example" "$recipe_dir/.env"
  if [ -n "$mutation" ]; then
    sed "$mutation" "$recipe_dir/.env" >"$recipe_dir/.env.tmp"
    mv "$recipe_dir/.env.tmp" "$recipe_dir/.env"
  fi
}

# Run `docker compose config` through the self-host wrapper with an ambient
# environment restricted to the given VAR=value pairs (simulating inherited
# shell pollution). The wrapper must scrub everything except the Docker
# transport allowlist, so only the env file may influence the rendered model.
run_wrapper_config() {
  (
    cd "$recipe_dir" || exit 1
    env -i PATH="$PATH" HOME="$HOME" "$@" \
      bash scripts/selfhost-compose.sh -f docker-compose.selfhost.yml config
  )
}

# ---------------------------------------------------------------------------
# The wrapper is the single Compose entry point for the checkout-managed
# self-host stack: repository-root .env is required, passed via --env-file, and
# ambient values cannot override it. These cases drive the real `docker compose
# config` through scripts/selfhost-compose.sh.
# ---------------------------------------------------------------------------

make_env 's/^FRONTEND_PORT=.*/FRONTEND_PORT=3100/'
printf '\nBACKEND_PORT=9100\n' >>"$recipe_dir/.env"

config="$(run_wrapper_config)"

require_config "$config" 'published: "3100"'
require_config "$config" 'published: "9100"'
require_config "$config" 'FRONTEND_ORIGIN: http://localhost:3100'
require_config "$config" 'GOOGLE_REDIRECT_URI: http://localhost:3100/auth/callback'
require_config "$config" 'MULTICA_APP_URL: http://localhost:3100'
pass 'wrapper renders .env ports and derived vars through docker compose config'

test_selfhost_wrapper_passes_compose_arguments() {
  local out

  make_env ''
  : >"$stub_dir/invocations"
  : >"$stub_dir/published"

  out="$(
    cd "$recipe_dir" || exit 1
    env PATH="$stub_dir:$PATH" bash scripts/selfhost-compose.sh version --short
  )"
  [ "$out" = "2.30.0" ] || fail "version --short did not pass through, got: $out"

  (
    cd "$recipe_dir" || exit 1
    env PATH="$stub_dir:$PATH" bash scripts/selfhost-compose.sh \
      -f docker-compose.selfhost.yml pull >/dev/null
  )
  (
    cd "$recipe_dir" || exit 1
    env PATH="$stub_dir:$PATH" bash scripts/selfhost-compose.sh \
      -f docker-compose.selfhost.yml -f docker-compose.selfhost.build.yml up -d >/dev/null
  )
  (
    cd "$recipe_dir" || exit 1
    env PATH="$stub_dir:$PATH" bash scripts/selfhost-compose.sh \
      -f docker-compose.selfhost.yml down >/dev/null
  )
  out="$(
    cd "$recipe_dir" || exit 1
    env PATH="$stub_dir:$PATH" bash scripts/selfhost-compose.sh \
      -f docker-compose.selfhost.yml port backend 8080
  )"
  [ -n "$out" ] || fail 'port did not pass through'

  grep -Fq 'version --short' "$stub_dir/invocations" || fail 'version probe not recorded'
  grep -Fq 'pull' "$stub_dir/invocations" || fail 'pull not recorded'
  grep -Fq 'up -d' "$stub_dir/invocations" || fail 'up -d not recorded'
  grep -Fq 'down' "$stub_dir/invocations" || fail 'down not recorded'
  grep -Fq 'port backend 8080' "$stub_dir/invocations" || fail 'port not recorded'
  pass 'wrapper passes compose arguments through unchanged'
}

for script in scripts/dev.sh scripts/check.sh; do
  if ! grep -Fq '. scripts/local-env.sh' "$script"; then
    echo "$script must source scripts/local-env.sh for shared local env derivation."
    exit 1
  fi
done

local_env="$(
  env -i PATH="$PATH" bash -c '
    set -euo pipefail
    env_file=$1
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
    # shellcheck disable=SC1091
    . scripts/local-env.sh
    printf "%s\n" \
      "PORT=${PORT}" \
      "FRONTEND_PORT=${FRONTEND_PORT}" \
      "FRONTEND_ORIGIN=${FRONTEND_ORIGIN}" \
      "MULTICA_APP_URL=${MULTICA_APP_URL}" \
      "GOOGLE_REDIRECT_URI=${GOOGLE_REDIRECT_URI}" \
      "MULTICA_SERVER_URL=${MULTICA_SERVER_URL}" \
      "LOCAL_UPLOAD_BASE_URL=${LOCAL_UPLOAD_BASE_URL}" \
      "PLAYWRIGHT_BASE_URL=${PLAYWRIGHT_BASE_URL}"
  ' _ "$tmp_env"
)"

require_env "$local_env" 'PORT=9100'
require_env "$local_env" 'FRONTEND_PORT=3100'
require_env "$local_env" 'FRONTEND_ORIGIN=http://localhost:3100'
require_env "$local_env" 'MULTICA_APP_URL=http://localhost:3100'
require_env "$local_env" 'GOOGLE_REDIRECT_URI=http://localhost:3100/auth/callback'
require_env "$local_env" 'MULTICA_SERVER_URL=ws://localhost:9100/ws'
require_env "$local_env" 'LOCAL_UPLOAD_BASE_URL=http://localhost:9100'
require_env "$local_env" 'PLAYWRIGHT_BASE_URL=http://localhost:3100'

worktree_env="$tmp_dir/.env.worktree"
WORKTREE_NAME=selfhost-config-test bash scripts/init-worktree-env.sh "$worktree_env" >/dev/null
worktree_backend_port="$(sed -n 's/^PORT=//p' "$worktree_env")"
require_env "$(cat "$worktree_env")" "MULTICA_PUBLIC_URL=http://localhost:${worktree_backend_port}"

resolve_local_public_url() {
  env -i PATH="$PATH" bash -c '
    set -euo pipefail
    env_file=$1
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
    # shellcheck disable=SC1091
    . scripts/local-env.sh
    printf "%s\n" "$MULTICA_PUBLIC_URL"
  ' _ "$1"
}

make_env_probe="$tmp_dir/print-public-url.mk"
printf '%s\n' \
  '.PHONY: print-public-url' \
  'print-public-url:' \
  '	@printf "%s\n" "$$MULTICA_PUBLIC_URL"' \
  >"$make_env_probe"

resolve_make_public_url() {
  make \
    --no-print-directory \
    -s \
    -f Makefile \
    -f "$make_env_probe" \
    ENV_FILE="$1" \
    print-public-url
}

old_worktree_env="$tmp_dir/.env.worktree.old"
grep -v '^MULTICA_PUBLIC_URL=' "$worktree_env" >"$old_worktree_env"
require_env \
  "$(resolve_local_public_url "$old_worktree_env")" \
  "http://localhost:${worktree_backend_port}"
require_env \
  "$(resolve_make_public_url "$old_worktree_env")" \
  "http://localhost:${worktree_backend_port}"

explicit_worktree_env="$tmp_dir/.env.worktree.explicit"
cp "$old_worktree_env" "$explicit_worktree_env"
printf '\nMULTICA_PUBLIC_URL=https://api.explicit.example\n' >>"$explicit_worktree_env"
require_env \
  "$(resolve_local_public_url "$explicit_worktree_env")" \
  "https://api.explicit.example"
require_env \
  "$(resolve_make_public_url "$explicit_worktree_env")" \
  "https://api.explicit.example"

# ---------------------------------------------------------------------------
# Host port consistency and up/wait configuration sharing (regression for
# #6145; acceptance: `up` and the readiness probe share one authoritative env).
#
# These cases drive the real `make selfhost` recipe. The docker stub does NOT
# get told what to publish: on `up` it asks the real `docker compose config` to
# interpolate the compose file with the environment the wrapper actually handed
# it, records that, and answers `port` from the recording. Because the wrapper
# sanitizes the environment, the stub keeps its state in files next to itself
# rather than in environment variables.
# ---------------------------------------------------------------------------

stub_dir="$tmp_dir/bin"
mkdir -p "$stub_dir"

cat >"$stub_dir/docker" <<'STUB'
#!/usr/bin/env bash
# `docker compose` stub. Derives the published host ports from the real compose
# interpolation of the environment this invocation received, so the recorded
# answer is whatever the recipe truly asked Compose for. State lives in files
# next to the stub because scripts/selfhost-compose.sh sanitizes the
# environment handed to Compose.
set -uo pipefail
stub_dir="$(cd "$(dirname "$0")" && pwd)"
record="$stub_dir/published"
rendered="$stub_dir/rendered.json"
invocations="$stub_dir/invocations"
real_docker="__REAL_DOCKER__"
printf '%s\n' "$*" >>"$invocations"
args=("$@")
sub=""
subidx=0
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[i]}" in
  up | pull | port | version | logs | down | build | config)
    sub=${args[i]}
    subidx=$i
    break
    ;;
  esac
done
files=()
env_file=""
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[i]}" in
  -f) files+=(-f "${args[i + 1]}") ;;
  --env-file) env_file=${args[i + 1]} ;;
  esac
done
case "$sub" in
version) echo "2.30.0" ;;
up | build)
  "$real_docker" compose ${env_file:+--env-file "$env_file"} "${files[@]}" config --format json 2>/dev/null \
    | tee "$rendered" \
    | node -e '
let raw = "";
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  const config = JSON.parse(raw);
  for (const service of ["backend", "frontend"]) {
    console.log(service + "=" + config.services[service].ports[0].published);
  }
});
' >>"$record"
  ;;
port)
  service=${args[subidx + 1]}
  published=$(grep "^${service}=" "$record" 2>/dev/null | tail -n 1 | cut -d= -f2)
  if [ -z "$published" ]; then exit 1; fi
  printf '127.0.0.1:%s\n' "$published"
  ;;
*) : ;;
esac
exit 0
STUB
sed -i "s#__REAL_DOCKER__#$(command -v docker)#" "$stub_dir/docker"

cat >"$stub_dir/curl" <<'STUB'
#!/usr/bin/env bash
# Records probed URLs and always reports a healthy backend.
set -uo pipefail
stub_dir="$(cd "$(dirname "$0")" && pwd)"
for arg in "$@"; do
  case "$arg" in
  http*) printf '%s\n' "$arg" >>"$stub_dir/curl-log" ;;
  esac
done
exit 0
STUB

chmod +x "$stub_dir/docker" "$stub_dir/curl"

# Runs `make <target>` against the stubs after applying a sed script to .env.
# Remaining args are passed through to make (environment assignments must be
# given as VAR=value before the target via `env`, make variables after it).
run_recipe() {
  local target=$1 env_mutation=$2 shell_env=$3 make_args=$4

  make_env "$env_mutation"
  : >"$stub_dir/published"
  : >"$stub_dir/curl-log"
  : >"$stub_dir/rendered.json"
  : >"$stub_dir/invocations"

  (
    cd "$recipe_dir" || exit 1
    eval "env PATH=\"$stub_dir:\$PATH\" $shell_env make $target $make_args"
  )
}

published_port() {
  grep "^$1=" "$stub_dir/published" | tail -n 1 | cut -d= -f2
}

probed_port() {
  sed -n '1s#http://localhost:\([0-9]*\)/health#\1#p' "$stub_dir/curl-log"
}

require_consistent() {
  local label=$1 expected=$2
  local published probed
  published=$(published_port backend)
  probed=$(probed_port)

  if [ "$published" != "$expected" ] || [ "$probed" != "$expected" ]; then
    echo "[$label] host port disagreement"
    echo "  expected published and probed port: $expected"
    echo "  compose published: ${published:-<none>}"
    echo "  health check probed: ${probed:-<none>}"
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Acceptance: the env file beats inherited shell values.
# ---------------------------------------------------------------------------

test_selfhost_env_file_beats_inherited_shell() {
  make_env 's/^PORT=8080/PORT=9100/;s/^FRONTEND_PORT=3000/FRONTEND_PORT=3100/;s/^MULTICA_IMAGE_TAG=latest/MULTICA_IMAGE_TAG=v-test-tag/'
  printf '\nMULTICA_APP_URL=https://env-file-sentinel.example\n' >>"$recipe_dir/.env"

  config="$(
    run_wrapper_config \
      PORT=9999 \
      FRONTEND_PORT=9998 \
      MULTICA_IMAGE_TAG=v-shell-tag \
      MULTICA_APP_URL=https://shell-sentinel.example
  )"

  require_config "$config" 'published: "9100"'
  require_config "$config" 'published: "3100"'
  require_config "$config" 'ghcr.io/multica-ai/multica-backend:v-test-tag'
  require_config "$config" 'MULTICA_APP_URL: https://env-file-sentinel.example'
  if grep -Fq 'shell-sentinel.example' <<<"$config" || grep -Fq 'v-shell-tag' <<<"$config"; then
    fail 'inherited shell values leaked into the rendered compose model'
  fi
  pass 'env file beats inherited shell values'
}

test_selfhost_env_file_beats_empty_and_conflicting_shell_values() {
  local ambient config

  make_env 's/^PORT=8080/PORT=9100/;s/^FRONTEND_PORT=3000/FRONTEND_PORT=3100/'

  for ambient in '' 'PORT=' 'PORT=9999' 'FRONTEND_PORT=9998' 'BACKEND_PORT=9997'; do
    if [ -n "$ambient" ]; then
      config="$(run_wrapper_config "$ambient")"
    else
      config="$(run_wrapper_config)"
    fi
    require_config "$config" 'published: "9100"'
    require_config "$config" 'published: "3100"'
  done
  pass 'env file beats unset, empty, and conflicting shell values'
}

test_selfhost_env_expansion_and_empty_values() {
  # Compose-side expansion like MULTICA_APP_URL=${FRONTEND_ORIGIN} must
  # survive: the wrapper passes the env file through and never `source`s it.
  make_env 's/^FRONTEND_PORT=3000/FRONTEND_PORT=3200/'
  config="$(run_wrapper_config FRONTEND_PORT=9999)"
  require_config "$config" 'MULTICA_APP_URL: http://localhost:3200'

  # Explicit empty assignments are distinct from absent ones and drop out of
  # the alias chain, falling through to PORT.
  make_env 's/^# BACKEND_PORT=8080/BACKEND_PORT=/'
  config="$(run_wrapper_config BACKEND_PORT=9000)"
  require_config "$config" 'published: "8080"'

  make_env 's/^FRONTEND_PORT=3000/FRONTEND_PORT=/'
  config="$(run_wrapper_config FRONTEND_PORT=3100)"
  require_config "$config" 'published: "3000"'
  pass 'env expansion and explicit empty values survive the wrapper'
}

test_selfhost_up_and_wait_share_authoritative_env() {
  run_recipe selfhost \
    's/^PORT=8080/PORT=9100/;s/^FRONTEND_PORT=3000/FRONTEND_PORT=3100/' \
    'PORT=9999 FRONTEND_PORT=9998' '' >/dev/null
  require_consistent 'up and wait share .env ports' 9100
  if [ "$(published_port frontend)" != "3100" ]; then
    fail "frontend port must come from .env (3100), got $(published_port frontend)"
  fi
  if grep -Fq '9999' "$stub_dir/rendered.json" || grep -Fq '9998' "$stub_dir/rendered.json"; then
    fail 'inherited shell ports leaked into the rendered compose model'
  fi
  pass 'up and wait share the authoritative env'
}

# PORT is the value to edit, so editing it must move the published port and the
# probe together. Fails on the old recipe, which probed 9100 while Compose
# published 8080.
run_recipe selfhost 's/^PORT=8080/PORT=9100/' '' '' >/dev/null
require_consistent 'PORT edited in .env' 9100

# BACKEND_PORT remains an alias that overrides PORT.
run_recipe selfhost 's/^# BACKEND_PORT=8080/BACKEND_PORT=9200/' '' '' >/dev/null
require_consistent 'BACKEND_PORT alias in .env' 9200

# Defaults stay 8080/3000.
run_recipe selfhost '' '' '' >/dev/null
require_consistent 'defaults' 8080
if [ "$(published_port frontend)" != "3000" ]; then
  echo "default frontend host port should be 3000, got $(published_port frontend)"
  exit 1
fi

# selfhost-build resolves the port the same way.
run_recipe selfhost-build 's/^PORT=8080/PORT=9400/' '' '' >/dev/null
require_consistent 'selfhost-build with PORT edited' 9400

# Every alias at once: BACKEND_PORT wins, and the probe follows it.
run_recipe selfhost \
  's/^PORT=8080/PORT=9000/;s/^# BACKEND_PORT=8080/BACKEND_PORT=8000/;s/^# API_PORT=8080/API_PORT=7000/;s/^# SERVER_PORT=8080/SERVER_PORT=6000/' \
  '' '' >/dev/null
require_consistent 'every alias set at once' 8000

# ---------------------------------------------------------------------------
# Make command-line variables and inherited shell values
#
# Previously a command-line assignment or an inherited shell value could
# override the env file (make includes .env; raw Compose lets the environment
# win). The wrapper now sanitizes the environment, so neither can reach
# Compose: the env file is the only source. Operators edit .env instead.
# ---------------------------------------------------------------------------

# A make command-line override must not desync the probe from Compose or reach
# it. Fails on the old recipe, which probed 8080 while Compose published 9100.
run_recipe selfhost 's/^# BACKEND_PORT=8080/BACKEND_PORT=9100/' '' 'PORT=8080' >/dev/null
require_consistent 'make PORT=8080 over BACKEND_PORT=9100' 9100

# A command-line high-priority alias cannot override the env file either.
run_recipe selfhost 's/^# API_PORT=8080/API_PORT=7000/' '' 'BACKEND_PORT=9000' >/dev/null
require_consistent 'command-line BACKEND_PORT cannot override env-file API_PORT' 7000

# An explicit empty value on the command line is ignored like any other value.
run_recipe selfhost '' '' 'BACKEND_PORT=' >/dev/null
require_consistent 'command-line BACKEND_PORT= ignored' 8080

# ---------------------------------------------------------------------------
# Explicit empty assignments in the env file
#
# `BACKEND_PORT=` is a distinct input from an absent one: it drops out of the
# alias chain instead of setting a port. Compose treats it the same way, and
# the wrapper preserves the env file verbatim.
# ---------------------------------------------------------------------------

run_recipe selfhost 's/^# BACKEND_PORT=8080/BACKEND_PORT=/' 'BACKEND_PORT=9000' '' >/dev/null
require_consistent 'empty BACKEND_PORT in .env over shell BACKEND_PORT' 8080

run_recipe selfhost 's/^PORT=8080/PORT=/;s/^# BACKEND_PORT=8080/BACKEND_PORT=/' 'PORT=9000' '' >/dev/null
require_consistent 'every chain variable emptied in .env' 8080

run_recipe selfhost 's/^FRONTEND_PORT=3000/FRONTEND_PORT=/' 'FRONTEND_PORT=3100' '' >/dev/null
if [ "$(published_port frontend)" != "3000" ]; then
  echo "an empty FRONTEND_PORT in .env must fall back to 3000, got $(published_port frontend)"
  exit 1
fi

# The recipes must delegate instead of re-deriving the port, and every
# self-host Compose call must go through the wrapper.
for expected_call in 'bash scripts/selfhost-wait.sh official' 'bash scripts/selfhost-wait.sh build'; do
  if ! grep -Fq "$expected_call" Makefile; then
    echo "Makefile must call the shared wait script: $expected_call"
    exit 1
  fi
done
if grep -n 'localhost:$${PORT' Makefile; then
  echo "The self-host recipes must not re-derive the backend host port from \$PORT."
  echo "Use scripts/selfhost-wait.sh, which reads the published port from Compose."
  exit 1
fi
if grep -nF '$(COMPOSE) -f docker-compose.selfhost' Makefile; then
  echo "Self-host recipes must invoke Compose through scripts/selfhost-compose.sh, not raw \$(COMPOSE)."
  exit 1
fi
if ! grep -Fq 'scripts/selfhost-compose.sh' scripts/selfhost-wait.sh; then
  echo "scripts/selfhost-wait.sh must query published ports through the self-host wrapper."
  exit 1
fi

# ---------------------------------------------------------------------------
# The backend port alias chain through the wrapper
#
#   BACKEND_PORT -> API_PORT -> SERVER_PORT -> PORT -> 8080
#
# Exercised through scripts/selfhost-compose.sh — the same entry point `make
# selfhost*` and scripts/selfhost-wait.sh use — with the ambient environment
# sanitized: the env file alone determines the rendered model.
# ---------------------------------------------------------------------------

# Neither installer may reconstruct the port from the env file again.
for installer in scripts/install.sh scripts/install.ps1; do
  if grep -nE '(selfhost_backend_port|selfhost_frontend_port|Get-SelfHostBackendPort|Get-SelfHostFrontendPort)' "$installer"; then
    echo "$installer must not re-derive host ports from .env."
    echo "Read the published port from Compose, as scripts/selfhost-wait.sh does."
    exit 1
  fi
done
for installer_call in \
  'compose_published_port backend 8080' \
  'compose_published_port frontend 3000'; do
  if ! grep -Fq "$installer_call" scripts/install.sh; then
    echo "scripts/install.sh must read the published port from Compose: $installer_call"
    exit 1
  fi
done
for installer_call in \
  'Get-ComposePublishedPort -Service "backend" -ContainerPort 8080' \
  'Get-ComposePublishedPort -Service "frontend" -ContainerPort 3000'; do
  if ! grep -Fq "$installer_call" scripts/install.ps1; then
    echo "scripts/install.ps1 must read the published port from Compose: $installer_call"
    exit 1
  fi
done

compose_wrapper_published_ports() {
  (
    cd "$recipe_dir" || exit 1
    env -i PATH="$PATH" HOME="$HOME" "$@" \
      bash scripts/selfhost-compose.sh -f docker-compose.selfhost.yml config --format json
  ) |
    node -e '
let raw = "";
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  const config = JSON.parse(raw);
  console.log(config.services.backend.ports[0].published + " " + config.services.frontend.ports[0].published);
});
'
}

# Each case: label, sed applied to .env.example, ambient env, expected backend,
# expected frontend. .env.example ships PORT=8080 with every alias commented
# out. Ambient values must never win: the wrapper scrubs them.
while IFS='|' read -r case_label case_mutation case_ambient case_backend case_frontend; do
  [ -n "$case_label" ] || continue

  make_env "$case_mutation"
  read -r observed_backend observed_frontend < <(
    compose_wrapper_published_ports ${case_ambient:+"$case_ambient"}
  )

  if [ "$observed_backend" != "$case_backend" ] || [ "$observed_frontend" != "$case_frontend" ]; then
    echo "[$case_label] Compose published an unexpected host port"
    echo "  expected: backend=$case_backend frontend=$case_frontend"
    echo "  observed: backend=$observed_backend frontend=$observed_frontend"
    exit 1
  fi
done <<'CASES'
defaults|||8080|3000
PORT only|s/^PORT=8080/PORT=9100/||9100|3000
SERVER_PORT overrides PORT|s/^# SERVER_PORT=8080/SERVER_PORT=9200/||9200|3000
API_PORT overrides SERVER_PORT|s/^# API_PORT=8080/API_PORT=9300/;s/^# SERVER_PORT=8080/SERVER_PORT=9200/||9300|3000
BACKEND_PORT overrides all|s/^# BACKEND_PORT=8080/BACKEND_PORT=9400/;s/^# API_PORT=8080/API_PORT=9300/;s/^# SERVER_PORT=8080/SERVER_PORT=9200/||9400|3000
ambient PORT cannot beat the env file|s/^PORT=8080/PORT=9100/|PORT=9500|9100|3000
ambient BACKEND_PORT cannot beat the env file|s/^PORT=8080/PORT=9100/|BACKEND_PORT=9600|9100|3000
ambient API_PORT cannot beat the env file|s/^PORT=8080/PORT=9100/|API_PORT=9700|9100|3000
ambient SERVER_PORT cannot beat the env file|s/^PORT=8080/PORT=9100/|SERVER_PORT=9800|9100|3000
ambient FRONTEND_PORT cannot beat the env file|s/^FRONTEND_PORT=3000/FRONTEND_PORT=3100/|FRONTEND_PORT=3200|8080|3100
CASES
pass 'backend port alias chain via the wrapper'

# An env-file alias beats the same alias from the environment, and the probe
# follows whatever Compose published either way.
for shadowed_alias in BACKEND_PORT API_PORT SERVER_PORT; do
  run_recipe selfhost "s/^# ${shadowed_alias}=8080/${shadowed_alias}=9700/" \
    "${shadowed_alias}=9600" '' >/dev/null
  require_consistent "env-file ${shadowed_alias} over the same shell variable" 9700
done
pass 'env-file aliases beat the same shell variable'

# ---------------------------------------------------------------------------
# Failure injection: missing / unreadable .env must fail closed before any
# Docker invocation, with an actionable, secret-free message.
# ---------------------------------------------------------------------------

test_selfhost_missing_env_fails_before_docker() {
  local output

  rm -f "$recipe_dir/.env"
  : >"$stub_dir/invocations"
  output="$(
    cd "$recipe_dir" || exit 1
    env PATH="$stub_dir:$PATH" make selfhost 2>&1
  )" && fail 'make selfhost must fail when .env is missing'
  if ! grep -Fq 'Missing or unreadable self-host configuration file: .env' <<<"$output"; then
    echo "expected the actionable missing-.env message, got:" >&2
    echo "$output" >&2
    exit 1
  fi
  if [ -s "$stub_dir/invocations" ]; then
    echo "docker must not be invoked when .env is missing, saw:" >&2
    cat "$stub_dir/invocations" >&2
    exit 1
  fi
  pass 'missing .env fails before docker'
}

test_selfhost_unreadable_env_fails_before_docker() {
  local output

  # Through the wrapper directly: make dies on the unreadable include before
  # any recipe can run, so the wrapper is the path that must emit the message.
  make_env ''
  chmod 000 "$recipe_dir/.env"
  : >"$stub_dir/invocations"
  output="$(
    cd "$recipe_dir" || exit 1
    env PATH="$stub_dir:$PATH" bash scripts/selfhost-compose.sh version --short 2>&1
  )" && fail 'wrapper must fail when .env is unreadable'
  if ! grep -Fq 'Missing or unreadable self-host configuration file: .env' <<<"$output"; then
    echo "expected the actionable unreadable-.env message, got:" >&2
    echo "$output" >&2
    exit 1
  fi
  if [ -s "$stub_dir/invocations" ]; then
    echo "docker must not be invoked when .env is unreadable, saw:" >&2
    cat "$stub_dir/invocations" >&2
    exit 1
  fi

  # The make-level path also fails closed (make itself refuses the include),
  # still without any Docker call.
  : >"$stub_dir/invocations"
  output="$(
    cd "$recipe_dir" || exit 1
    env PATH="$stub_dir:$PATH" make selfhost 2>&1
  )" && fail 'make selfhost must fail when .env is unreadable'
  if [ -s "$stub_dir/invocations" ]; then
    echo "docker must not be invoked when .env is unreadable, saw:" >&2
    cat "$stub_dir/invocations" >&2
    exit 1
  fi
  chmod 600 "$recipe_dir/.env"
  pass 'unreadable .env fails before docker'
}

# ---------------------------------------------------------------------------
# Secret safety: sentinel values in .env and the inherited shell environment
# must never appear in captured output, on success or on failure.
# ---------------------------------------------------------------------------

test_selfhost_errors_never_emit_values() {
  local sentinel_env sentinel_shell output

  sentinel_env='SENTINEL_ENV_VALUE_9f3c2a'
  sentinel_shell='SENTINEL_SHELL_VALUE_7b1d4e'

  make_env 's/^PORT=8080/PORT=9100/'
  printf '\n%s=present\n' "$sentinel_env" >>"$recipe_dir/.env"

  # Success path: captured stdout+stderr of a full `make selfhost` run.
  run_recipe selfhost '' "$sentinel_shell=present" '' >"$tmp_dir/success.out" 2>"$tmp_dir/success.err"
  output="$(cat "$tmp_dir/success.out" "$tmp_dir/success.err")"
  if grep -Fq "$sentinel_env" <<<"$output" || grep -Fq "$sentinel_shell" <<<"$output"; then
    echo "sentinel value leaked into self-host success output" >&2
    exit 1
  fi

  # Failure path: missing .env.
  : >"$stub_dir/invocations"
  output="$(
    cd "$recipe_dir" || exit 1
    env PATH="$stub_dir:$PATH" "$sentinel_shell=present" make selfhost 2>&1
  )" || true
  if grep -Fq "$sentinel_env" <<<"$output" || grep -Fq "$sentinel_shell" <<<"$output"; then
    echo "sentinel value leaked into missing-.env failure output" >&2
    exit 1
  fi

  # Failure path: unreadable .env through the wrapper.
  make_env ''
  chmod 000 "$recipe_dir/.env"
  output="$(
    cd "$recipe_dir" || exit 1
    env PATH="$stub_dir:$PATH" "$sentinel_shell=present" bash scripts/selfhost-compose.sh version --short 2>&1
  )" || true
  if grep -Fq "$sentinel_env" <<<"$output" || grep -Fq "$sentinel_shell" <<<"$output"; then
    echo "sentinel value leaked into unreadable-.env failure output" >&2
    exit 1
  fi
  chmod 600 "$recipe_dir/.env"

  pass 'errors never emit values'
}

test_selfhost_wrapper_passes_compose_arguments
test_selfhost_env_file_beats_inherited_shell
test_selfhost_env_file_beats_empty_and_conflicting_shell_values
test_selfhost_env_expansion_and_empty_values
test_selfhost_up_and_wait_share_authoritative_env
test_selfhost_missing_env_fails_before_docker
test_selfhost_unreadable_env_fails_before_docker
test_selfhost_errors_never_emit_values

echo "self-host env derivation ok"
