#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
docker compose -f infra/docker/docker-compose.dev.yml down
npx -y supabase@2.117.0 stop --workdir infra
