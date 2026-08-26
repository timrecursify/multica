#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"

default_config="$(docker compose -f "$root/docker-compose.yml" config --format json)"
override_config="$(COMPOSE_PROJECT_NAME=multica docker compose -f "$root/docker-compose.yml" config --format json)"
selfhost_config="$(docker compose -f "$root/docker-compose.selfhost.yml" config --no-interpolate --format json)"

[[ "$(jq -r '.name' <<<"$default_config")" == multica-dev ]]
[[ "$(jq -r '.services | keys | join(",")' <<<"$default_config")" == dev-postgres ]]
[[ "$(jq -r '.volumes | keys | join(",")' <<<"$default_config")" == dev_pgdata ]]
[[ "$(jq -r '.volumes.dev_pgdata.name' <<<"$default_config")" == multica_dev_pgdata ]]
[[ "$(jq -r '.networks.default.name' <<<"$default_config")" == multica_dev_default ]]

# COMPOSE_PROJECT_NAME has higher precedence than top-level name. Even under
# that hostile/ambient override, the dev service and volume keys must remain
# disjoint from the production/self-host postgres + pgdata keys.
[[ "$(jq -r '.name' <<<"$override_config")" == multica ]]
[[ "$(jq -r '.services | keys | join(",")' <<<"$override_config")" == dev-postgres ]]
[[ "$(jq -r '.volumes | keys | join(",")' <<<"$override_config")" == dev_pgdata ]]
[[ "$(jq -r '.volumes.dev_pgdata.name' <<<"$override_config")" == multica_dev_pgdata ]]
[[ "$(jq -r '.networks.default.name' <<<"$override_config")" == multica_dev_default ]]

[[ "$(jq -r '.name' <<<"$selfhost_config")" == multica ]]
[[ "$(jq -r '.services | has("postgres")' <<<"$selfhost_config")" == true ]]
[[ "$(jq -r '.volumes | has("pgdata")' <<<"$selfhost_config")" == true ]]
[[ "$(jq -r '.networks.default.name' <<<"$selfhost_config")" == multica_default ]]

make_preview="$(make -s -C "$root" -n db-up)"
grep -Fq 'docker compose up -d dev-postgres' <<<"$make_preview"
grep -Fq 'docker compose exec -T dev-postgres' "$root/scripts/ensure-postgres.sh"

# Developer Compose targets must not route through the self-host wrapper: the
# wrapper requires the repository-root .env and sanitizes the environment,
# which would break shared dev-postgres management for worktrees.
for target in db-up db-down db-reset; do
  preview="$(make -s -C "$root" -n "$target")"
  if grep -Fq 'selfhost-compose' <<<"$preview"; then
    echo "developer target $target must not use the self-host wrapper" >&2
    exit 1
  fi
done

printf 'PASS: normal dev Compose reconciliation cannot replace production postgres resources\n'
