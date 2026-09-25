<div align="center">

# Bus Mitra

**Live bus tracking for the CBIT campus fleet.**
Real-time map, per-stop ETAs, and arrival alerts that tell you when to leave — not when you've already missed it.

Department of Information Technology · Chaitanya Bharathi Institute of Technology

[![Status](https://img.shields.io/badge/status-in%20development-yellow)](tracker.md)
[![Stage](https://img.shields.io/badge/all%2010%20stages-built-yellow)](#roadmap)
[![License](https://img.shields.io/badge/license-TBD-lightgrey)](#license)

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](docs/ARCHITECTURE.md#2-tech-stack)
[![Next.js](https://img.shields.io/badge/Next.js-15-000000?logo=nextdotjs&logoColor=white)](docs/ARCHITECTURE.md#2-tech-stack)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres%20%2B%20PostGIS-3ECF8E?logo=supabase&logoColor=white)](docs/ARCHITECTURE.md#2-tech-stack)
[![Redis](https://img.shields.io/badge/Redis-Streams-DC382D?logo=redis&logoColor=white)](docs/ARCHITECTURE.md#2-tech-stack)

[Architecture](docs/ARCHITECTURE.md) · [Data Model](docs/SCHEMA.md) · [Build Plan](docs/BUILD_PLAN.md) · [Engineering Vault](vault/)

</div>

---
> [!IMPORTANT]
> **Project status (2026-09-25): all ten stages are built and tested; what remains needs real buses, real phones, accounts or people.** Stage 8 added dead-zone learning, end-to-end tracing, dashboards, alerts and a health page in the console, and was measured: **600 students and a 1,000-student headroom run at p95 4.0–4.1 s from GPS fix to frame, a critical alert to all of them with zero duplicates, and five chaos drills (Redis, Postgres, a worker killed mid-send, OSRM flooded, a revoked push key) with no lost data** — two drills found real bugs, now fixed. Stage 9 added production configuration and images, a restore drill that rebuilds the database and proves it matches, a per-request CSP checked in a browser, a GT06 hardware-tracker adapter, a Telugu/Hindi driver app and the handover pack. **Not yet:** production is not provisioned, the pilot has not run, and ETA accuracy on real buses — the gate for leave-now alerts — is still unmeasured.
>
> **Stages 0, 4, 1, 2, 3, 5, 7 and 6 are built and tested. Students can watch the fleet live, search any stop, follow a bus with a live ETA and a "leave in" countdown, and get alerts on their phone. The Transport Department has a working console.**
> Working today: everything below the student UI (identity with RLS, route capture and editing, a fleet simulator, signed ingest with offline buffering); the **live map** — every running bus over Server-Sent Events, gliding between fixes, amber and red when a bus stops reporting, and gone ten minutes later; **stop search** that forgives misspellings and finds stops near a locality; a **home pin** stored at ~100 m; **per-stop ETA ranges** with a confidence dot; and a **leave-now** evaluator that emits one event per student (delivery is Stage 6).
> Verified on 2026-09-23 against the full local stack in a real browser: 30 buses on the map with a p95 of 4.0 s from GPS fix to pixel; all four presence states on time at both cadences with zero false alarms; a cut network and a SIGKILLed gateway both recover without a reload.
> **TD console (2026-09-24):** fleet, drivers and QR tracker pairing; out of commission → ticket → back in service; a ticket queue with auto-opened signal-loss tickets; announcements with a live recipient count; event-day bus lists from a CSV with a rendered diff; a live fleet dashboard; an audit log. Every send states the number of students it will reach, and the gateway refuses it if that number has changed. Verified in a real browser.
> **Alerts (2026-09-24):** web push to installed and browser PWAs (event → push in the browser p95 2.4 s through Google's push service), SMS fallback for critical and urgent alerts, a notification center that records everything, *Follow* / *Not today*, favourites, and a kill switch, quiet hours and alert levels. Every adversarial test in the build plan passes: no duplicates after a crash, one alert for a flapping stop, none for replayed history.
> Not yet: push on a real iPhone and the phone-side latency (need a phone), real SMS (needs DLT approval), a usability session with a TD member. **Stage 6 was built ahead of its gate:** leave-now alerts should not be switched on for real students until the ETA is measured on real buses. **ETA accuracy on real buses is not measured yet:** that needs ten real trips, and it gates the alerts. **Also still open:** a GitHub CI run, real SMS (DLT), one real surveyed route, and a stopwatch-timed walk. See [`tracker.md`](tracker.md).

---

## Table of contents

- [The problem](#the-problem)
- [What it does](#what-it-does)
- [Design principles](#design-principles)
- [Targets](#targets)
- [Tech stack](#tech-stack)
- [Architecture at a glance](#architecture-at-a-glance)
- [Getting started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Without Docker: tests only](#without-docker-tests-only)
  - [Full local stack](#full-local-stack)
  - [Environment variables](#environment-variables)
  - [Useful commands](#useful-commands)
- [Project structure](#project-structure)
- [Roadmap](#roadmap)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [Acknowledgments](#acknowledgments)
- [License](#license)

## The problem

A student leaves for their stop at 7:40 with no information. The bus already passed at 7:38. They wait twenty minutes for a bus that is not coming, or they run for one that is four minutes behind them.

Nobody outside the driver knows where a campus bus is. Printed timetables do not survive traffic, breakdowns or route changes. Coordination happens over WhatsApp and phone calls, and nothing is recorded.

Bus tracking is a solved problem — for regulators and for city transit. It is not solved for a single campus fleet, where the economics of city-wide public transit do not apply and government AIS-140 compliance devices feed state servers rather than student-facing search, favourites and alerts.

## What it does

**For students**

| | |
|---|---|
| **Live map** ✅ | Every running bus, updating continuously, with smooth motion between GPS pings, and an honest "last seen" when a bus stops reporting. |
| **Search any stop** ✅ | Type `Dilsukhnagar` — or misspell it, `dilsuknagar`, `kothi` — and see every bus serving that area with a live ETA range. |
| **Leave-now alerts** 🟡 | Pin where you start from. The app counts down "leave in N min" and sends one urgent alert when it is time — built and tested; to be switched on once ETA accuracy is proven on real buses. |
| **Favourites** ✅ | One main bus for urgent alerts, plus any number of starred buses for lighter ones — with *Follow* / *Not today* right on the notification. |
| **Notification center** ✅ | Tiered history of every announcement, alert and service ticket, written even when a push or SMS fails. |
| **Kill switch** ✅ | One tap once you're aboard silences everything for three hours; critical alerts still come through. |

**For the Transport Department**

| | |
|---|---|
| **Fleet console** ✅ | Live status of every bus, last-ping age, today's ETA accuracy; buses, drivers, QR pairing of tracker phones. |
| **Announcements** ✅ | Tiered broadcasts to everyone, to first-years, to seniors, or to one route — with a recipient count shown before anything is sent. |
| **Event-day lists** ✅ | Upload a CSV of buses running today; separate lists for juniors and seniors. Two-phase with a diff preview, so no malformed file ever reaches a student's phone. |
| **System health** ✅ | One page with the five alert rules, live latency, processing backlog, notification delivery, ETA accuracy by route, and a map of the places buses routinely lose signal (rename them the way students know them). |
| **Hardware trackers** 🟡 | Wired GT06 tracker boxes can replace drivers' phones through the adapter, with trips started by the ignition — built and tested against a software tracker; a physical one is pending. |
| **Service tickets** ✅ | Mark a bus out of commission and it raises a tracked ticket and a critical alert (push + SMS); resolving it puts the bus back in service and tells the same students. |

## Design principles

**Never fabricate a position or an ETA.** When a bus enters a cellular dead zone, the app shows an honest `last seen 2m ago` rather than a frozen dot that looks live. Every degraded state is designed, specific and visible. A stale timestamp shown plainly beats a confident wrong answer.

**Dead zones are learned, not feared.** Repeated outages at the same location are clustered into known-dead-zone polygons. After two weeks the app stops raising alarms and starts explaining: *"Bus 14 is in a known dead zone near the Uppal flyover — usually clears in about 90 seconds."*

**The database is never on the live read path.** GPS ingestion writes to a Redis stream; students read from an SSE fan-out. Persistence runs on a separate lagging consumer. A read spike at 4 p.m. cannot degrade GPS collection, and Postgres going down does not take the live map with it.

**Notifications are tiered and idempotent.** Five tiers from `CRITICAL` to `AMBIENT`. A twelve-stop route produces *one* notification that updates in place, not twelve stacked ones. A database-level uniqueness constraint makes double-notification structurally impossible, because notification fatigue is the fastest way to lose a user permanently.

**Correctness under degradation, not throughput.** Thirty buses at a 5-second cadence is six writes per second and about four kilobytes of live state. The engineering difficulty here is being right when the network is bad — not being fast when it is good. The one place scale does bite is readers: everybody opens the app in the same five minutes, so peak concurrency tracks ridership almost 1:1 rather than being a comfortable fraction of it.

## Targets

| | |
|---|---|
| **End-to-end latency** | ~3 s p50, ~6 s p95, from GPS ping to pixel |
| **ETA accuracy** | MAE under 90 s at a 10-minute horizon |
| **Alert latency** | Under 10 s p95, from event to phone |
| **Scale** | 30 buses, ~600 concurrent students at peak |
| **Recurring cost** | ≈ ₹5,600/month at pilot, ≈ ₹8,000/month at full fleet (≈ ₹20 per student per year) |

## Tech stack

| Layer | Choice |
|---|---|
| **Web app** | Next.js 15 · React 19 · TypeScript · Tailwind v4 · shadcn/ui · MapLibre GL · self-hosted vector tiles |
| **Driver app** | Vite + React PWA · Geolocation API · Screen Wake Lock · IndexedDB buffer |
| **API & realtime** | Fastify 5 · Server-Sent Events · Node 22 |
| **Workers** | BullMQ · Redis Streams |
| **Data** | Supabase (Postgres 15 · PostGIS · `pg_trgm` · Auth · Storage · RLS) · Drizzle |
| **Geo** | OSRM (self-hosted, `car` + `foot`) · Photon geocoding |
| **Delivery** | Web Push (VAPID) · MSG91 SMS fallback for urgent tiers |
| **Ops** | Docker Compose · OpenTelemetry · Grafana Cloud · Sentry · k6 · GitHub Actions |

Full reasoning for every choice, including the rejected alternatives, is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#2-tech-stack).

## Architecture at a glance

```
Driver PWA / hardware tracker
        │  batched, HMAC-signed, offline-buffered
        ▼
   Fastify gateway ──────────► Redis Streams ──────────► BullMQ workers
   (ingest · SSE · REST)              │              (snap · ETA · geofence
        │                             │               presence · notify)
        │                             ▼                       │
        │                    Redis: live fleet                │
        ▼                             │                       ▼
   Student web app ◄─── SSE ──────────┘              Web Push / SMS
                                                             │
                                   Supabase Postgres + PostGIS
                                     (system of record)
```

Full topology, latency budget and failure-mode table: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Getting started

### Prerequisites

- Node.js 22+ and pnpm 10 (`npm i -g pnpm`)
- For the full local stack only: Docker (Desktop, OrbStack, or `brew install colima docker docker-compose` then `colima start --memory 8`), `osmium-tool`, python3 and ~6 GB free disk. Preprocessing needs well under 1 GB of RAM (measured). The Supabase CLI runs via `npx`, so no separate install is needed.

### Without Docker: tests only

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test   # 568 tests; database suites run on in-process Postgres (PGlite),
                                           # Redis-backed suites are skipped unless a Redis is reachable
```

### Full local stack

```bash
pnpm install
cp .env.example .env              # every variable is documented inline
infra/osrm/prepare.sh             # one-time (~1 min + a 99 MB download): Telangana extract → Hyderabad clip → car + foot graphs
infra/tiles/prepare.sh            # one-time (~30 s): Hyderabad vector tiles (--full also fetches ~1.4 GB of ocean/low-zoom data)
pnpm dev                          # validates .env, starts Supabase + Redis + OSRM ×2 + Photon + tiles + Mailpit,
                                  # applies migrations + dev seed, smoke-tests routing and tiles, runs gateway,
                                  # engine, web and the driver app
```

Then open <http://localhost:3000/claim> and claim roll `160125737001`. With `SMS_PROVIDER=console` the OTP appears in the gateway log. To get an admin, claim `TDADMIN01` and run the promotion SQL in [`infra/supabase/seed.sql`](infra/supabase/seed.sql).

**No cloud account is required for local development or testing.**

#### Buses on the map, without a bus

```bash
pnpm sim seed                              # 8 routes on real Hyderabad roads, through the real
                                           # survey → map-match → publish pipeline (~3 s)
pnpm sim run --buses 30 --minutes 60       # 30 buses in real time: GPS noise, dead zones,
                                           # duplicate and out-of-order batches, then a verdict
pnpm sim run --buses 3 --minutes 5 --airplane 2:1:3   # bus 2 offline for two minutes
```

The run ends by checking itself: every fix it sent is in `positions` exactly once, the ones
flushed late are flagged `is_backfill`, and no bus's live entry ever moved backwards in time.
Open <http://localhost:3000> signed in while it runs to watch the buses; `pnpm sim watch --cut SIM-02`
judges every presence transition, and `pnpm sim eta-report` prints ETA accuracy per horizon.
Run one simulator fleet at a time: each run re-provisions the same `SIM-*` trackers.

#### Driving a real phone

```bash
pnpm tracker provision --bus 14            # prints a pairing link, once
pnpm --filter @busmitra/driver dev         # the driver PWA on :5173
```

Open the pairing link on the phone (set `VITE_GATEWAY_URL` to the laptop's LAN address first),
pick a route, press **START TRIP**. Survey mode records a 1 Hz trace for a new route; the
Transport Department matches and publishes it under Admin → Routes.

### Environment variables

Every variable is listed and explained in [`.env.example`](.env.example), with its purpose, where to obtain it, and whether it is secret. The gateway and `pnpm env:check` refuse to start while any variable is missing or malformed, and they list each one by name. The groups are Supabase, Redis, geo services (OSRM car/foot, Photon, tiles), SMS (`console` in dev, `msg91` after DLT approval), gateway keys (`CLAIM_DECOY_KEY`, `TRACKER_SECRET_KEY`), the `NEXT_PUBLIC_*` values for the web app, and — all optional — telemetry (`OTEL_*`), Sentry DSNs and the hardware adapter (`GATEWAY_URL`, `ADAPTER_*`). Production secrets and where each lives are listed in [`docs/handover/campus-it.md`](docs/handover/campus-it.md).

### Useful commands

| Command | Does |
|---|---|
| `pnpm dev` / `pnpm dev:down` | Start / stop the full local stack |
| `pnpm env:check` | Validate `.env`; names every missing or malformed variable |
| `pnpm smoke` | Check both OSRM profiles route and the tile server serves a tile |
| `pnpm test` | Unit + database tests (Vitest, PGlite; Redis suites need a Redis) |
| `pnpm sim seed` · `pnpm sim run` | Seed dev routes · drive simulated buses through the real gateway |
| `pnpm sim watch` · `pnpm sim eta-report` | Judge presence transitions of a live run · ETA accuracy from `eta_predictions` |
| `node --experimental-strip-types tests/e2e/{live-map,resilience,stage5}.ts` | Real-browser checks (headless Chrome) against the running stack |
| `pnpm tracker provision --bus 14` · `pnpm tracker rotate --device …` | Pair a driver phone · rotate its secret |
| `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres pnpm vitest run packages/db apps` | The database suites on the real Supabase Postgres 15 |
| `bash infra/scripts/observability.sh` | Local Grafana + Prometheus + Tempo on :3001 (set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`) |
| `pnpm sim load --clients 600 --minutes 10` | The Stage 8 load run: k6 SSE clients + 30 buses + a T0 broadcast, then a verdict (stop `pnpm dev` first) |
| `pnpm sim chaos redis\|postgres\|worker\|osrm\|vapid` | One chaos drill against real processes, with a measured verdict |
| `pnpm sim deadzone-check --learn` | Run the dead-zone learner now and compare with the zones the simulator injected |
| `pnpm --filter @busmitra/engine deadzone` | Run the nightly dead-zone learner once |
| `pnpm tracker provision --bus 14 --kind hardware --device <IMEI>` | Pair a GT06 hardware tracker (prints its adapter entry) |
| `GATEWAY_URL=… ADAPTER_DEVICES_FILE=… pnpm --filter @busmitra/adapter start` | Run the GT06 adapter (not part of `pnpm dev`: only where wired trackers exist) |
| `bash infra/scripts/restore-drill.sh` | Back up the database, restore it into a fresh Supabase-shaped database, verify it matches |
| `pnpm typecheck` · `pnpm lint` · `pnpm format` | Static checks |
| `pnpm build` | Production builds (needs the `NEXT_PUBLIC_*` variables) |

## Project structure

Entries marked ✅ exist today. The rest are planned (see `docs/BUILD_PLAN.md`).

```
apps/
  web/          ✅ Next.js 15 — live map, stop search, stop page, hero ETA + timeline, home pin,
                   sign-in/claim/recovery, settings; TD console: live fleet, fleet + pairing,
                   tickets, announcements, event-day CSV, roster, routes, stops, audit log
  driver/       ✅ Vite PWA — GPS tracker with offline buffering, and route survey mode
  gateway/      ✅ Fastify 5 — auth, admin APIs, signed tracker ingest, SSE stream, search, /v1/me
  engine/       ✅ workers — roster, survey matching, geo, persister, presence, stop events,
                   per-stop ETA, leave-now, event-day lists + scheduled trips, signal-loss
                   tickets, scheduled announcements
  simulator/    ✅ Synthetic fleet: seeds routes, drives buses, verifies the run; the Stage 8
                   load harness (`sim load`) and chaos drills (`sim chaos`)
  adapter/      ✅ GT06 hardware-tracker adapter: TCP in, the phone's signed ingest contract out
packages/
  contracts/    ✅ Zod schemas — ping, SSE, tracker API, roster + event-day CSV, auth, route
                   editor, admin console, notify events
  db/           ✅ SQL migrations, RLS policies, PGlite + Postgres 15 test harness
  geo/          ✅ Snapping, progress, stop crossings, ETA — pure, 100% line coverage
  notify/       ✅ Tiering and per-user filters, Web Push (VAPID), SMS (console, MSG91) with receipts
  redis/        ✅ Typed key registry, fleet state, stream helpers
  config/       ✅ Environment parsing and shared constants (incl. the alert thresholds)
  telemetry/    ✅ OpenTelemetry (traces across Redis streams, metrics), rolling latency windows
  ui/           ✅ Design tokens (both themes) and presence styles
infra/          ✅ Docker compose, OSRM + tile prep, Supabase config, dev scripts; Grafana dashboards
                   and alert rules; Fly.io configs, the production geo box, the Node image;
                   backup + restore-drill scripts
docs/           ✅ Architecture, schema, build plan, outreach drafts; handover pack (driver sheet,
                   TD handbook, student guide, campus-IT handover)
vault/          ✅ Engineering log — modules, ADRs, runbooks, benchmarks
tests/          ✅ e2e (headless-Chrome harnesses), recorded GPS fixtures, k6 load test (+ xk6-sse)
```

## Roadmap

Ten stages, each independently demonstrable, built in the order **0 → 4 → 1 → 2 → 3 → 5/7 → 6 → 8 → 9**. Full detail, exit criteria and the risk register are in [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md). Live status is in [`tracker.md`](tracker.md).

| Order | Stage | Delivers | Status |
|---|---|---|---|
| 1 | **0** | Monorepo, local Docker stack, CI, contracts | 🟡 Built and run; GitHub CI run and DLT/roster requests pending |
| 2 | **4** | Roster import, roll-number claim flow, RLS | 🟡 Built, run live on Supabase; real SMS (DLT) pending |
| 3 | **1** | Geo core, route survey and editor, fleet simulator | 🟡 Built and tested; one real route still to be surveyed |
| 4 | **2** | Driver tracker, ingest pipeline, offline buffering | 🟡 Built and tested; airplane test on a real phone pending |
| 5 | **3** | SSE delivery, live map, dead-zone presence states | 🟢 Complete |
| 6 | **5** | Stop search, location pinning, per-student ETA | 🟡 Built; stopwatch walk and the real-bus ETA soak pending (the soak gates Stage 6) |
| 6 | **7** | Admin console, announcements, CSV lists, tickets | 🟡 Built and browser-tested; TD usability session pending |
| 7 | **6** | Push + SMS, tiering, notification center, kill switch | 🟡 Built ahead of its gate; iPhone, phone latency, real SMS and the Stage 5 soak pending |
| 8 | **8** | Dead-zone learning, observability, load testing | 🔵 Built and measured (600 + 1,000 students, five chaos drills); the real-route dead-zone soak pending |
| 9 | **9** | Production deployment, hardware trackers, pilot | 🟡 Built and proven locally (images, restore drill, CSP, GT06 adapter, handover); provisioning, pilot and a physical tracker pending |

Rollout follows the project deck: **3 buses → measure ETA accuracy for two weeks → 10 buses → full fleet.** No fleet-wide hardware spend until the pilot proves accuracy on real routes.

## Documentation

| Document | Contents |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System design, tech stack reasoning, core algorithms, latency budget, failure modes |
| [`docs/SCHEMA.md`](docs/SCHEMA.md) | Every table, index, enum, RLS policy and Redis key |
| [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md) | The ten stages with exit criteria and a risk register |
| [`vault/`](vault/) | Engineering log: per-module notes, ADRs, runbooks, benchmarks |
| [`docs/handover/`](docs/handover/) | Driver sheet (EN/TE/HI), TD handbook, student guide, campus-IT handover |
| [`Bus_Mitra.md`](Bus_Mitra.md) | Original project deck — problem framing, alternatives, cost model |

## Contributing

Contributions, issues and feature requests are welcome. Please open an issue to discuss a significant change before submitting a pull request.

Every stage of the build plan ends with the same three steps, which are part of the work and not paperwork afterwards:

1. A **vault module entry** from [`vault/_TEMPLATE.md`](vault/_TEMPLATE.md) — including the gotchas and the dead ends.
2. An **ADR** in `vault/decisions/` for any decision that was genuinely close, recording the rejected options.
3. A **README update**, so this file never overstates what works.

A `CONTRIBUTING.md` with commit conventions and PR checklist will be added alongside Stage 0.

## Acknowledgments

- [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors — the map and road-network data this project is built on. © OpenStreetMap contributors, data available under the [Open Database License](https://opendatacommons.org/licenses/odbl/).
- [OSRM](https://project-osrm.org/) — self-hosted routing engine used for route derivation and ETA calculation.
- [MapLibre GL JS](https://maplibre.org/) — the open-source map renderer that keeps this project vendor-free.
- [Supabase](https://supabase.com/) — Postgres, PostGIS, Auth and Storage in one open-source platform.
- The CBIT Department of Information Technology and Transport Department, for the problem statement and operational data this design is built around.

## License

Not yet licensed. Until a `LICENSE` file is added, all rights are reserved by the authors and no reuse, modification or redistribution is permitted — this is the default under copyright law for any public repository without an explicit license. A permissive open-source license will be selected before the Stage 9 public/campus-wide release; see [choosealicense.com](https://choosealicense.com/) for the shortlist under consideration.

**One caveat to settle before that release.** Route geometry in this project is produced by map-matching surveyed GPS traces against OpenStreetMap road data via OSRM. That arguably makes the resulting `routes` and `stops` data a *Derivative Database* under the [ODbL](https://opendatacommons.org/licenses/odbl/), which carries share-alike obligations — obligations that do not sit comfortably alongside an all-rights-reserved posture. This affects the **route data**, not the application code. It is very likely a non-issue in practice (publishing campus bus routes costs nothing and helps everyone), but it should be a decision rather than an oversight.

<!-- ## Contact

Department of Information Technology, Chaitanya Bharathi Institute of Technology.

For questions, proposals or to report an issue, please [open an issue](../../issues) in this repository. -->
