#!/usr/bin/env bash
# `pnpm dev` — bring the whole local stack up (ARCHITECTURE §9), verify it, then run the apps.
#   1. validate .env           (fails naming the missing variable)
#   2. Supabase CLI stack       (Postgres + Auth + Storage + Studio), migrations applied
#   3. docker compose           (Redis, OSRM car+foot, Photon, tiles, Mailpit)
#   4. smoke test               (both OSRM profiles route, tile server returns a tile)
#   5. app dev servers via turbo (none exist before Stage 4)
set -euo pipefail
cd "$(dirname "$0")/../.."

pnpm -s env:check

command -v docker >/dev/null || {
  echo "dev: docker is not installed — install Docker Desktop or OrbStack first" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "dev: the docker daemon is not running" >&2; exit 1; }

for f in infra/osrm/data/car/hyderabad.osrm.mldgr infra/osrm/data/foot/hyderabad.osrm.mldgr infra/tiles/data/hyderabad.mbtiles; do
  [[ -f "$f" ]] || { echo "dev: missing $f — run infra/osrm/prepare.sh then infra/tiles/prepare.sh (one-time)" >&2; exit 1; }
done

# The Supabase CLI only reads migrations from <workdir>/supabase/migrations; the source of
# truth is packages/db/migrations (SCHEMA.md header), so mirror it in before starting.
if [[ -d packages/db/migrations ]]; then
  rm -rf infra/supabase/migrations && mkdir -p infra/supabase/migrations
  cp packages/db/migrations/*.sql infra/supabase/migrations/
fi
npx -y supabase@2.117.0 start --workdir infra

docker compose -f infra/docker/docker-compose.dev.yml up -d --wait redis osrm-car osrm-foot tiles mailpit
docker compose -f infra/docker/docker-compose.dev.yml up -d photon   # slow first start; not waited on

bash infra/scripts/smoke.sh

if ls apps/*/package.json >/dev/null 2>&1; then
  exec pnpm exec turbo run dev --parallel
else
  echo "dev: stack is up; no apps exist yet"
fi
