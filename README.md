<div align="center">

# Bus Mitra

**Live bus tracking for the CBIT campus fleet.**
Real-time map, per-stop ETAs, and arrival alerts that tell you when to leave — not when you've already missed it.

Department of Information Technology · Chaitanya Bharathi Institute of Technology

[![Status](https://img.shields.io/badge/status-design%20complete-blue)](docs/BUILD_PLAN.md)
[![Stage](https://img.shields.io/badge/stage-0%20of%209-lightgrey)](#roadmap)
[![License](https://img.shields.io/badge/license-TBD-lightgrey)](#license)

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](docs/ARCHITECTURE.md#2-tech-stack)
[![Next.js](https://img.shields.io/badge/Next.js-15-000000?logo=nextdotjs&logoColor=white)](docs/ARCHITECTURE.md#2-tech-stack)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres%20%2B%20PostGIS-3ECF8E?logo=supabase&logoColor=white)](docs/ARCHITECTURE.md#2-tech-stack)
[![Redis](https://img.shields.io/badge/Redis-Streams-DC382D?logo=redis&logoColor=white)](docs/ARCHITECTURE.md#2-tech-stack)

[Architecture](docs/ARCHITECTURE.md) · [Data Model](docs/SCHEMA.md) · [Build Plan](docs/BUILD_PLAN.md) · [Engineering Vault](vault/)

</div>

---
<!-- 
> [!IMPORTANT]
> **Project status: design complete, implementation not started.**
> The architecture, data model and staged build plan in `docs/` are finalised. No application code exists yet.
> The **Getting Started** section below describes the intended developer experience and becomes real at the end of Stage 0. This README is updated at the end of every stage to reflect only what actually works. -->

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
  - [Setup](#setup)
  - [Running a simulated fleet](#running-a-simulated-fleet)
  - [Useful commands](#useful-commands)
- [Project structure](#project-structure)
- [Roadmap](#roadmap)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [Acknowledgments](#acknowledgments)
- [License](#license)
- [Contact](#contact)

## The problem

A student leaves for their stop at 7:40 with no information. The bus already passed at 7:38. They wait twenty minutes for a bus that is not coming, or they run for one that is four minutes behind them.

Nobody outside the driver knows where a campus bus is. Printed timetables do not survive traffic, breakdowns or route changes. Coordination happens over WhatsApp and phone calls, and nothing is recorded.

Bus tracking is a solved problem — for regulators and for city transit. It is not solved for a single campus fleet, where the economics of city-wide public transit do not apply and government AIS-140 compliance devices feed state servers rather than student-facing search, favourites and alerts.

## What it does

**For students**

| | |
|---|---|
| **Live map** | Every running bus, updating continuously, with smooth motion between GPS pings. |
| **Search any stop** | Type `Dilsukhnagar` — or misspell it — and see every bus serving that area with a live ETA. |
| **Leave-now alerts** | Pin where you start from. Get one urgent notification when the bus is closer to your stop than you are. |
| **Favourites** | One main bus for urgent alerts, plus any number of starred buses for lighter ones. |
| **Notification center** | Tiered history of every announcement, alert and service ticket. |
| **Kill switch** | One tap once you're aboard silences everything for three hours. |

**For the Transport Department**

| | |
|---|---|
| **Fleet console** | Live status of every bus, tracker health, last-ping age. |
| **Announcements** | Tiered broadcasts to everyone, to first-years, to seniors, or to one route — with a recipient count shown before anything is sent. |
| **Event-day lists** | Upload a CSV of buses running today; separate lists for juniors and seniors. Two-phase with a diff preview, so no malformed file ever reaches a student's phone. |
| **Service tickets** | Mark a bus out of commission and it raises a tracked, acknowledgeable alert that students can follow to resolution. |

## Design principles

**Never fabricate a position or an ETA.** When a bus enters a cellular dead zone, the app shows an honest `last seen 2m ago` rather than a frozen dot that looks live. Every degraded state is designed, specific and visible. A stale timestamp shown plainly beats a confident wrong answer.

**Dead zones are learned, not feared.** Repeated outages at the same location are clustered into known-dead-zone polygons. After two weeks the app stops raising alarms and starts explaining: *"Bus 14 is in a known dead zone near the Uppal flyover — usually clears in about 90 seconds."*

**The database is never on the live read path.** GPS ingestion writes to a Redis stream; students read from an SSE fan-out. Persistence runs on a separate lagging consumer. A read spike at 4 p.m. cannot degrade GPS collection, and Postgres going down does not take the live map with it.

**Notifications are tiered and idempotent.** Five tiers from `CRITICAL` to `AMBIENT`. A twelve-stop route produces *one* notification that updates in place, not twelve stacked ones. A database-level uniqueness constraint makes double-notification structurally impossible, because notification fatigue is the fastest way to lose a user permanently.

**Correctness under degradation, not throughput.** Thirty buses at a 5-second cadence is six writes per second and about four kilobytes of live state. The engineering difficulty here is being right when the network is bad — not being fast when it is good.

## Targets

| | |
|---|---|
| **End-to-end latency** | ~3 s p50, ~6 s p95, from GPS ping to pixel |
| **ETA accuracy** | MAE under 90 s at a 10-minute horizon |
| **Alert latency** | Under 10 s p95, from event to phone |
| **Scale** | 30 buses, 300 concurrent students |
| **Recurring cost** | ≈ ₹5,200/month all-in (≈ ₹18 per student per year) |

## Tech stack

| Layer | Choice |
|---|---|
| **Web app** | Next.js 15 · React 19 · TypeScript · Tailwind v4 · shadcn/ui · MapLibre GL |
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

> Available from the end of **Stage 0**. Documented here as the target developer experience.

### Prerequisites

- Node.js 22+ and pnpm 9+
- Docker Desktop
- Supabase CLI
- ~10 GB free disk (OSRM preprocessing of the Telangana OSM extract)

### Setup

```bash
git clone <repo-url> campus-bus
cd campus-bus
pnpm install

cp .env.example .env.local        # every variable is documented inline

pnpm osrm:prepare                 # one-time; downloads and preprocesses the OSM extract
pnpm dev                          # brings up the full local stack
```

`pnpm dev` starts Supabase (Postgres + PostGIS, Auth, Storage), Redis, both OSRM profiles, Photon and Mailpit; applies migrations; seeds routes, stops and test users; and launches the gateway, engine, web app and driver app.

**No cloud account is required for local development or testing.**

### Running a simulated fleet

```bash
pnpm simulate --buses 30 --noise 8 --deadzones 2
```

Drives thirty synthetic buses along real published routes with realistic GPS noise and injected dead zones. This is how every stage after Stage 1 is tested — waiting for a real bus to move is not a development loop.

### Useful commands

| Command | Does |
|---|---|
| `pnpm dev` | Full local stack |
| `pnpm test` | Unit tests (Vitest) |
| `pnpm test:e2e` | End-to-end tests (Playwright) |
| `pnpm test:load` | Load tests (k6) |
| `pnpm db:migrate` | Apply migrations |
| `pnpm db:seed` | Reseed local data |
| `pnpm simulate` | Synthetic fleet |

## Project structure

```
apps/
  web/          Next.js — student PWA + TD admin console
  driver/       Vite PWA — GPS tracker + route survey
  gateway/      Fastify — ingest, SSE, REST
  engine/       BullMQ workers — geo, ETA, geofence, presence, notify
  simulator/    Synthetic fleet for development and load testing
packages/
  contracts/    Zod schemas shared across every app
  db/           Drizzle schema, migrations, RLS policies
  geo/          Snapping, route progress, ETA — pure, heavily tested
  notify/       Tiering, templates, push + SMS adapters
  redis/        Typed key registry and stream helpers
  config/       Environment parsing and shared constants
  ui/           Shared components and design tokens
infra/          Docker, OSRM, Supabase configuration
docs/           Architecture, schema, build plan
vault/          Engineering log — modules, ADRs, runbooks, benchmarks
tests/          E2E, load, and recorded GPS fixtures
```

<!-- ## Roadmap

Ten stages, each independently demonstrable. Full detail, including exit criteria and a risk register, in [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md).

| Stage | Delivers | Status |
|---|---|---|
| **0** | Monorepo, local Docker stack, CI, contracts | ⬜ Not started |
| **1** | Geo core, route survey and editor, fleet simulator | ⬜ Not started |
| **2** | Driver tracker, ingest pipeline, offline buffering | ⬜ Not started |
| **3** | SSE delivery, live map, dead-zone presence states | ⬜ Not started |
| **4** | Roster import, roll-number claim flow, RLS | ⬜ Not started |
| **5** | Stop search, location pinning, per-student ETA | ⬜ Not started |
| **6** | Push + SMS, tiering, notification center, kill switch | ⬜ Not started |
| **7** | Admin console, announcements, CSV lists, tickets | ⬜ Not started |
| **8** | Dead-zone learning, observability, load testing | ⬜ Not started |
| **9** | Production deployment, hardware trackers, pilot | ⬜ Not started |

Rollout follows the project deck: **3 buses → measure ETA accuracy for two weeks → 10 buses → full fleet.** No fleet-wide hardware spend until the pilot proves accuracy on real routes.

See also: [open issues](../../issues) and [pull requests](../../pulls) for work in progress. -->

## Documentation

| Document | Contents |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System design, tech stack reasoning, core algorithms, latency budget, failure modes |
| [`docs/SCHEMA.md`](docs/SCHEMA.md) | Every table, index, enum, RLS policy and Redis key |
| [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md) | The ten stages with exit criteria and a risk register |
| [`vault/`](vault/) | Engineering log: per-module notes, ADRs, runbooks, benchmarks |
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

<!-- ## Contact

Department of Information Technology, Chaitanya Bharathi Institute of Technology.

For questions, proposals or to report an issue, please [open an issue](../../issues) in this repository. -->
