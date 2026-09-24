#!/usr/bin/env bash
# Stage 8 — start the local observability stack (Grafana, Prometheus, Tempo, OTLP collector)
# and give the read-only metrics role a local-only login. Then restart the gateway and engine
# with OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 (see .env.example).
set -euo pipefail
cd "$(dirname "$0")/../.."

# the role exists from migration 0009 without a login; locally it gets a throwaway password.
# In production the operator sets a real one (vault/runbooks/deploy.md) — never this one.
docker exec supabase_db_busmitra psql -U postgres -v ON_ERROR_STOP=1 -qc \
  "ALTER ROLE busmitra_metrics LOGIN PASSWORD 'metrics-local-only'"

docker compose -f infra/docker/docker-compose.dev.yml --profile observability up -d --wait lgtm
echo "observability: Grafana http://localhost:3001 (admin/admin) → Dashboards → Bus Mitra"
echo "observability: export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 for gateway + engine"
