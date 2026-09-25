# Bus Mitra — campus IT handover

For whoever keeps Bus Mitra running after the build team: CBIT campus IT, or the next student
team. Assumes you can use a terminal, Git and Docker. The design documents are
[ARCHITECTURE.md](../ARCHITECTURE.md), [SCHEMA.md](../SCHEMA.md) and
[BUILD_PLAN.md](../BUILD_PLAN.md); the operating procedures are the runbooks in
[vault/runbooks/](../../vault/runbooks/).

---

## 1. What runs where

| Piece | Where | Deployed by | Notes |
|---|---|---|---|
| Postgres, Auth, Storage | **Supabase Pro**, Mumbai (`ap-south-1`) | migrations in `packages/db/migrations` | the system of record |
| Gateway (API, ingest, SSE) | **Fly.io** app `busmitra-gateway`, `bom`, 2 machines | `infra/fly/gateway.toml` | stateless; scale by machine count |
| Engine (workers) | **Fly.io** app `busmitra-engine`, `bom`, **exactly 1 machine** | `infra/fly/engine.toml` | two engines split the geo consumer group |
| Redis | Fly Redis or a Redis 7 beside the engine, AOF on | — | the live fleet; losing it costs ~1 s (ADR-0002) |
| OSRM car + foot, Photon, tiles | one **4 vCPU / 8 GB VPS** | `infra/prod/geo` (Docker Compose + Caddy) | tiles public via Cloudflare; OSRM/Photon behind a path token |
| Web (students + console) | **Vercel** `bom1` | `apps/web/vercel.json` | CSP per request (middleware) |
| Driver app | **Cloudflare Pages** | `apps/driver/public/_headers` | static; `VITE_GATEWAY_URL` at build |
| GT06 adapter (hardware stage) | **Fly.io** `busmitra-adapter`, TCP 5023 | `infra/fly/adapter.toml` | only once wired trackers are fitted |
| Metrics, traces, alerts | **Grafana Cloud** (OTLP) | `infra/grafana` (dashboard + alert rules) | the console's **Health** page shows the same numbers without Grafana |
| Errors | **Sentry** (web, driver) | DSNs as env vars | no personal data is sent (see `apps/web/lib/sentry.ts`) |

Domains (example): `busmitra.in` (web), `api.busmitra.in` (gateway), `driver.busmitra.in`,
`tiles.busmitra.in`, `geo.busmitra.in` (DNS-only, not proxied).

## 2. Secrets

Every variable is documented in [`.env.example`](../../.env.example); the ones marked SECRET
live only in Fly secrets, Vercel env, GitHub Actions secrets and the geo box's `.env`.

| Secret | Holds | If it leaks |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` | full database access | rotate in Supabase; redeploy gateway + engine |
| `SUPABASE_JWT_SECRET` | can mint any user's token | rotate in Supabase (signs everyone out) |
| `TRACKER_SECRET_KEY` | decrypts every tracker's HMAC secret | **re-encrypt** (`pnpm tracker rotate` per tracker after changing it) — never just change it |
| `VAPID_PRIVATE_KEY` | signs push | see [runbook: push not delivering](../../vault/runbooks/push-not-delivering.md) — rotating costs every student a re-subscribe (the app heals it on their next visit) |
| `CLAIM_DECOY_KEY` | decoy phone masking | rotate freely |
| `MSG91_AUTH_KEY`, `SMS_RECEIPT_TOKEN` | SMS | rotate in MSG91; update the receipt webhook URL |
| `GEO_TOKEN` | the path into OSRM/Photon | change on the box and in `OSRM_*_URL`/`PHOTON_URL` |
| `ADAPTER_DEVICES_JSON` | every wired tracker's secret | rotate each tracker (`tracker rotate`) |

## 3. Routine operations

| Task | How |
|---|---|
| Deploy a change | [runbooks/deploy.md](../../vault/runbooks/deploy.md) — migrations first, then engine, then gateway, then web |
| Roll back | [runbooks/rollback.md](../../vault/runbooks/rollback.md) |
| Backups | Supabase Pro daily backups (7 days) **plus** our own nightly logical dump to off-site storage (`.github/workflows/backup.yml`); restore drill: `infra/scripts/restore-drill.sh` — run it every term |
| New academic year | TD uploads the roster in the console; the cohort promotion job runs itself on 1 August |
| Pair a wired tracker | `pnpm tracker provision --bus 14 --kind hardware --device <IMEI>` → paste the printed entry into `ADAPTER_DEVICES_JSON`; configure the box by SMS (typically `SERVER,1,<adapter host>,5023,0#` and `TIMER,10,60#` — the syntax varies by vendor: check the device manual) |
| Watch health | the console's **Health** page; Grafana *Bus Mitra — overview*; the five alert rules page on-call |

## 4. When something breaks

Runbooks are named after the symptom you will see:

| Symptom | Runbook |
|---|---|
| A bus is not on the map | [bus-not-appearing.md](../../vault/runbooks/bus-not-appearing.md) |
| The map stopped updating | [live-map-not-updating.md](../../vault/runbooks/live-map-not-updating.md) |
| Map says "reconnecting", buses buffering | [map-reconnecting-redis-down.md](../../vault/runbooks/map-reconnecting-redis-down.md) |
| History / search / console errors, live map fine | [history-and-console-down-postgres.md](../../vault/runbooks/history-and-console-down-postgres.md) |
| Alerts stopped or arrived late | [alerts-late-or-missing.md](../../vault/runbooks/alerts-late-or-missing.md) |
| ETAs wide / walking times missing | [etas-wide-or-walking-times-missing.md](../../vault/runbooks/etas-wide-or-walking-times-missing.md) |
| Push notifications failing | [push-not-delivering.md](../../vault/runbooks/push-not-delivering.md) |
| A student cannot claim an account | [student-cannot-claim.md](../../vault/runbooks/student-cannot-claim.md) |
| A CSV upload is rejected | [csv-upload-failed.md](../../vault/runbooks/csv-upload-failed.md) |

## 5. Rules you must not break

The 15 invariants in [Read_this_first.md](../../Read_this_first.md) §3 are load-bearing. The ones
an operator can break by accident:

- **Never run two engines.** The Fly config deploys it with `strategy = "immediate"` for this reason.
- **Never edit a published route in place** — publish a new version (the console does this).
- **Never delete from `dead_zones`, `signal_outages`, `trips`** — history depends on them.
- **Never commit a secret, a roster CSV or a phone number** to the repository.

## 6. Costs (ARCHITECTURE §9)

≈ ₹68,000/year at pilot (driver phones), ≈ ₹95,000/year at full fleet with M2M SIMs. The
collapsible items, if the envelope is hard: Vercel → Cloudflare Pages, Supabase Pro →
self-hosted Postgres on the geo box (then backups are entirely yours).
