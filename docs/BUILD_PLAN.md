# Bus Mitra — Build Plan

> Ten stages. Each one is independently demonstrable, leaves the repository in a working state, and ends with a written vault entry and a README update.
>
> Read [ARCHITECTURE.md](ARCHITECTURE.md) and [SCHEMA.md](SCHEMA.md) first — this document assumes both.

---

## Decisions locked for this plan

| Question | Decision | Consequence |
|---|---|---|
| **GPS source** | Driver PWA for the pilot; wired hardware at fleet stage, behind the same ingest contract | Route capture and ingestion become the *same* build (Stages 1–2). No hardware lead time blocks software. |
| **Route geometry** | None exists — capture it ourselves | Stage 1 grows a GPS-survey mode and an admin route editor. This is the largest single piece of net-new scope. |
| **iOS push** | PWA install prompt + SMS fallback for T0/T1 | ⚠️ **DLT registration with MSG91 is a 1–2 week regulatory process. Start it on day one of Stage 0.** |
| **Auth** | Roll number + password, seeded from a TD roster, claimed via phone OTP | Stage 4 depends on the Transport Department actually handing over a roster CSV with phone numbers. That is a people dependency — chase it during Stage 0. |

---

## Dependency graph

```
Stage 0  Foundations
   │
   ├──► Stage 1  Geo core + route capture ──┐
   │                                        │
   ├──► Stage 4  Identity + roster ─────────┤
   │                                        │
   └──► Stage 2  Ingestion ◄────────────────┘
                     │
                     ▼
              Stage 3  Live delivery
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
  Stage 5  Search + ETA     Stage 7  Admin console
        │                         │
        └────────────┬────────────┘
                     ▼
              Stage 6  Notification spine
                     │
                     ▼
        Stage 8  Learning + observability + load
                     │
                     ▼
        Stage 9  Production + hardware
```

Stages 1 and 4 are independent of each other and can run in parallel if there is more than one person. Everything after Stage 3 is sequential — **do not start Stage 6 before Stage 5**, because the notification spine is meaningless without per-student ETAs to trigger on.

Day estimates below assume one focused developer. Halve the wall-clock for a pair working the parallel branches.

---

## Folder structure

Created in Stage 0, grown by every stage after.

```
campus-bus/
├── apps/
│   ├── web/                     # Next.js 15 — student PWA + TD admin console
│   │   ├── app/
│   │   │   ├── (student)/       # map, search, stop, favourites, notifications, settings
│   │   │   ├── (admin)/         # fleet, routes, announcements, roster, tickets, audit
│   │   │   ├── (auth)/          # claim, login, recover
│   │   │   └── api/             # BFF only — NEVER SSE (see ADR-0001)
│   │   ├── components/
│   │   │   ├── map/             # MapLibre canvas, markers, interpolation, route layer
│   │   │   ├── eta/             # the hero ETA card, confidence dot, route timeline
│   │   │   ├── notifications/   # center, tier badges, ticket cards
│   │   │   └── admin/
│   │   ├── lib/
│   │   │   ├── sse/             # EventSource client, reconnect, Last-Event-ID
│   │   │   ├── store/           # Zustand fleet store
│   │   │   └── push/            # subscription lifecycle, permission UX
│   │   └── public/sw.ts         # Serwist: push + notificationclick handlers
│   │
│   ├── driver/                  # Vite + React PWA — tracker & survey (separate origin)
│   │   └── src/
│   │       ├── tracker/         # watchPosition, wake lock, batch, IndexedDB buffer
│   │       ├── survey/          # dense-trace route capture mode
│   │       └── trip/            # start/end trip, route selection, status
│   │
│   ├── gateway/                 # Fastify — ingest, REST, SSE
│   │   └── src/
│   │       ├── routes/ingest/   # HMAC verify, validate, XADD
│   │       ├── routes/stream/   # SSE fan-out, focus, resume
│   │       ├── routes/api/      # search, favourites, profile, admin
│   │       └── plugins/         # auth, rate-limit, otel, error mapping
│   │
│   ├── engine/                  # BullMQ workers
│   │   └── src/workers/
│   │       ├── geo.ts           # snap → progress → speed
│   │       ├── geofence.ts      # route-crossing stop arrivals
│   │       ├── eta.ts           # per-stop ETA + leave-now ticker
│   │       ├── presence.ts      # 5 s sweeper: LIVE/DEGRADED/DARK/ENDED
│   │       ├── notify.ts        # tier → audience → dedupe → channel
│   │       ├── persister.ts     # batched COPY into positions
│   │       ├── roster.ts        # CSV parse → diff → apply
│   │       └── deadzone.ts      # nightly DBSCAN clustering
│   │
│   └── simulator/               # synthetic fleet — the dev/test workhorse
│
├── packages/
│   ├── contracts/               # Zod schemas + types: ingest, SSE, API, CSV
│   ├── db/                      # Drizzle schema, migrations, seed, RLS policies
│   ├── geo/                     # snap, progress, crossing, eta — pure functions
│   ├── notify/                  # tiering, templates, web-push + SMS adapters
│   ├── redis/                   # typed key registry, stream + fleet-state helpers
│   ├── config/                  # Zod-parsed env, shared thresholds and constants
│   └── ui/                      # shared components + design tokens
│
├── infra/
│   ├── docker/                  # compose files, Dockerfiles
│   ├── osrm/                    # extract + preprocess scripts, car & foot profiles
│   └── supabase/                # config.toml, seed.sql
│
├── tests/
│   ├── e2e/                     # Playwright
│   ├── load/                    # k6
│   └── fixtures/                # recorded GPS traces — the geo regression corpus
│
├── vault/                       # engineering log (see vault/README.md)
├── docs/                        # ARCHITECTURE, SCHEMA, BUILD_PLAN, API
└── README.md
```

**Why `packages/geo` is its own package with no dependencies:** it holds the maths that is silently wrong when it is wrong. Nobody notices a 12% ETA bias for weeks. Isolating it as pure functions makes it testable against recorded traces, and `tests/fixtures` becomes a regression corpus that grows every time a real bus does something unexpected.

---

# Stage 0 — Foundations

**~3 days. Nothing user-visible. Every later stage is faster or slower depending on how honestly this one is done.**

### Build

- pnpm workspace + Turborepo pipeline; TypeScript project references; `strict` with `noUncheckedIndexedAccess`.
- ESLint + Prettier + `lint-staged`; Vitest configured at the root.
- `docker-compose.dev.yml`: Supabase CLI stack, Redis 7, OSRM car + foot, Photon, Mailpit.
- `infra/osrm/prepare.sh` — download the Telangana Geofabrik extract, run `osrm-extract` + `osrm-partition` + `osrm-customize` for both profiles. ⚠️ Preprocessing wants ~8 GB RAM; do it once and commit the artefacts to a release asset, not to git.
- `packages/config` — Zod-parsed environment, failing loudly at boot on a missing variable. One `.env.example` with every key documented.
- `packages/contracts` — the first schemas: `Ping`, `PingBatch`, `SseEvent`.
- GitHub Actions: typecheck → lint → test → build, on every push.
- `vault/` structure + `_TEMPLATE.md`; `docs/` skeleton.
- **Start the MSG91 DLT registration.** It has a multi-week clock and blocks Stage 6.
- **Request the roster CSV** (roll no, name, admission year, phone) from the Transport Department. It blocks Stage 4.

### Components

`turbo.json` · `docker-compose.dev.yml` · `packages/config` · `packages/contracts` · `.github/workflows/ci.yml` · `vault/_TEMPLATE.md`

### Expect

`git clone && pnpm install && pnpm dev` brings the whole stack up on a clean machine with no cloud account and no internet beyond the initial pull. CI is green. Nothing else works yet, and that is correct.

### Exit criteria

- [ ] `pnpm dev` starts every container and both OSRM profiles answer a test route
- [ ] `pnpm test` and `pnpm typecheck` pass in CI
- [ ] A missing env var fails the boot with a readable message naming the variable
- [ ] DLT registration submitted; roster request sent
- [ ] `vault/modules/M00-foundations.md` written

---

# Stage 1 — Geo core and route capture

**~6 days. The mathematical heart of the product, plus the tooling to get real route data — which you do not currently have.**

### Build

**`packages/geo` — pure functions, no I/O:**

- `haversine`, `projectPointOnSegment`, `buildCumulativeDistances`
- `snapToRoute(ping, route, lastIndex)` with the forward-biased window and off-route detection (ARCHITECTURE §5.2)
- `enforceMonotonicProgress(sPrev, sNew, dt)` (§5.3)
- `detectCrossings(sPrev, sNow, routeStops, lastSeq)` (§5.4)
- `computeEta(s, targetOffset, speedModel, dwells)` returning `{p50, p90, confidence}` (§5.5)
- `simplifyTrace` (Douglas–Peucker) for survey cleanup

**Route capture — this is how you get geometry from nothing:**

- **Survey mode** in `apps/driver`: drive the route once with 1 Hz dense capture, no snapping, raw trace straight to storage.
- **Trace → route pipeline:** simplify → OSRM `/match` (map-matching to the road network) → canonical polyline → compute `cumulative_dist_m`.
- **Admin route editor** (`apps/web/(admin)/routes`): MapLibre canvas showing the matched polyline, drag to correct, drop stops along the line, name and alias each stop. Publishing computes each stop's `cumulative_dist_m` by projection and freezes the route version.

**Simulator (`apps/simulator`)** — the tool that makes every later stage testable:

- Drives N synthetic buses along real published routes at configurable speed profiles
- Injects realistic GPS noise (σ ≈ 8 m), configurable dead-zone windows, off-route excursions, stalls, and duplicate/out-of-order pings
- Replays recorded traces from `tests/fixtures` deterministically

### Components

`packages/geo` (+ its test suite) · `apps/driver/src/survey` · `apps/web/(admin)/routes` · trace→route pipeline · `apps/simulator` · `packages/db` schema for `routes`, `stops`, `route_stops`

### Expect

Drive one real bus route with a phone in survey mode, and end with a published, corrected route with ordered stops in the database. The simulator can then run a fake bus along it and the geo functions report correct offsets and stop crossings — verified against a hand-checked fixture.

### Why the simulator is not optional

Without it you can only test during the twice-daily windows when a real bus moves, you cannot reproduce a dead zone on demand, and you cannot load-test at all. **Two days spent here buys back two weeks across Stages 2–8.**

### Exit criteria

- [ ] `packages/geo` at >90% line coverage, including adversarial fixtures: GPS spike, backward jitter, 83 m ping gap at speed, route self-intersection
- [ ] At least one real route surveyed, matched, corrected and published
- [ ] Simulator drives 30 buses on real routes with injected noise and dead zones
- [ ] `vault/modules/M01-geo-core.md` + `ADR-0003-route-versioning.md`

---

# Stage 2 — Ingestion pipeline

**~5 days. From a phone on a dashboard to a durable, replayable stream.**

### Build

**`apps/driver` tracker mode:**

- `watchPosition({ enableHighAccuracy: true })`, throttled to 5 s moving / 30 s stationary
- **Screen Wake Lock API** so the screen stays on while mounted and charging
- IndexedDB ring buffer; every ping is written locally *before* the network is attempted
- Batch POST every 5 s, or on reconnect flush up to 500 buffered pings with original `recorded_at`
- Exponential backoff with jitter; `navigator.onLine` plus a heartbeat probe for genuine reachability
- Big, unmissable trip UI: route picker → **START TRIP** → live "N pings sent · M buffered" → **END TRIP**

**`apps/gateway` ingest:**

- `POST /v1/ingest` — HMAC-SHA256 over `(device_id, timestamp, body)`, 5-minute skew window, nonce replay cache in Redis
- Zod validation; per-device rate limit
- `is_backfill` marking when `ingested_at − recorded_at > 30 s`
- `XADD stream:pings`, then respond. **No database write on this path.**

**`apps/engine`:**

- `geo.ts` — consumer group on `stream:pings`: snap → monotonic progress → EWMA speed → write `fleet:live`
- `persister.ts` — separate consumer group, batches 200 rows or 2 s and `COPY`s into `positions`

### Components

`apps/driver/src/tracker` · `apps/gateway/routes/ingest` · `packages/redis` · `engine/geo.ts` · `engine/persister.ts` · `positions` partitioning + `pg_cron`

### Expect

Walk around the block with the driver app open: positions land in Redis within ~500 ms and in Postgres within ~2 s. Turn on airplane mode for three minutes, turn it off, and every buffered ping arrives with its original timestamps, flagged as backfill, without disturbing the live position.

### The known constraint, stated plainly

⚠️ **A browser PWA cannot reliably capture location in the background.** Android throttles background tabs hard; iOS suspends them. The driver app therefore requires the screen on (Wake Lock) with the phone mounted and charging. This is acceptable for a pilot and is documented in the driver onboarding sheet.

**Escape hatch if drivers will not cooperate:** wrap `apps/driver` in a Capacitor or TWA shell to get a real Android foreground service. The *student* app stays pure web — only the driver app changes, and the ingest contract does not move at all.

### Exit criteria

- [ ] 30 simulated buses ingest for one hour with zero dropped or duplicated pings
- [ ] Airplane-mode test: full backfill, correct ordering, `is_backfill` set, `fleet:live` unaffected
- [ ] Replayed batch produces no duplicate rows (unique index holds)
- [ ] Forged HMAC and stale-timestamp requests are rejected
- [ ] `vault/modules/M02-ingestion.md` + `runbooks/bus-not-appearing.md`

---

# Stage 3 — Live delivery

**~5 days. The first time this looks like a product.**

### Build

- **SSE gateway:** `GET /v1/stream`, per-user subscription sets, `POST /v1/stream/focus` for bbox scoping, 15 s heartbeat comments, `Last-Event-ID` replay from `stream:events`, 3-connection cap per user.
- **Presence sweeper** (`engine/presence.ts`): 5 s pass over `fleet:live` driving `LIVE → DEGRADED → DARK → ENDED`, writing `signal_outages` on every transition. Dead-zone *classification* lands here; dead-zone *learning* is Stage 8.
- **Student live map:** MapLibre with the app theme, route polylines, bus markers coloured by presence state, **client-side dead-reckoning interpolation** (ARCHITECTURE §4), stop markers, a bus detail sheet.
- **Honest degradation UI:** amber marker plus "last seen 34 s ago", red plus a timestamp for DARK, removal on ENDED. Designed states, not error toasts.
- **Zustand fleet store** fed by SSE; reconnect with backoff and a visible connection indicator.

### Components

`gateway/routes/stream` · `engine/presence.ts` · `apps/web/components/map` · `lib/sse` · `lib/store` · `packages/ui` design tokens

### Expect

Open the app on a phone and a laptop side by side. Run the simulator. Buses glide smoothly across both screens within ~3 s of a ping. Kill the simulator's network for one bus: it turns amber at 25 s, red at 75 s, and disappears at 10 minutes — and at no point does it show a confident position it does not have.

### Exit criteria

- [ ] 30 buses live on the map with smooth interpolation, no visible jumps
- [ ] All four presence states render correctly and transition on real timing
- [ ] Killing the network mid-stream reconnects and replays missed events without a page reload
- [ ] p95 ping-to-pixel latency under 6 s, measured, not assumed
- [ ] `vault/modules/M03-live-delivery.md` + `ADR-0001` (formalise the SSE decision)

---

# Stage 4 — Identity and roster

**~4 days. Can run in parallel with Stages 1–3.**

### Build

- Supabase Auth with synthetic `<roll_no>@students.busmitra.internal` identities.
- **Roster import:** TD uploads a CSV (roll no, name, admission year, phone, branch) → Zod-validated parse → diff preview → confirm → `roster_students` populated.
- **Claim flow:** roll number → OTP to the roster phone (MSG91; Mailpit/console in dev) → set password → `profiles` row created, phone marked verified.
- Rate limiting and lockout on the claim endpoint; generic failure messages so the roster cannot be enumerated.
- Role model and JWT claims; `is_admin()` helper; **RLS policies written and tested for every table that exists so far**.
- `cohort` derivation from `admission_year` plus the annual promotion job.
- Session handling, password recovery over SMS, and an account settings page.

### Components

`apps/web/(auth)` · `gateway/routes/api/auth` · `engine/roster.ts` (import half) · `packages/db` RLS policies · `packages/notify` SMS adapter (first use)

### Expect

A student on the TD roster can claim their account with their roll number and phone and log in. Someone not on the roster cannot, and cannot tell from the error message whether the roll number exists. An admin sees the admin console; a student hitting `/admin` gets a 404, not a redirect.

### Test explicitly

RLS is the security boundary and deserves adversarial tests: authenticate as student A and attempt to read student B's `profiles`, `favourites`, `push_subscriptions` and `notification_recipients` rows directly through the Supabase client. **Every one must return zero rows, not an error** — an error leaks existence.

### Exit criteria

- [ ] Full claim flow works end to end with a real SMS
- [ ] Roster enumeration attack returns identical responses for existing and non-existing roll numbers
- [ ] RLS adversarial suite passes; policies exist on 100% of tables
- [ ] Junior/senior cohorts correctly derived across an academic-year boundary
- [ ] `vault/modules/M04-identity.md` + `runbooks/student-cannot-claim.md`

---

# Stage 5 — Stops, search and personal ETA

**~6 days. Where the app becomes useful rather than merely impressive.**

### Build

**Stop search — the "Dilsukhnagar" requirement:**

```
query → pg_trgm fuzzy over stops.name + aliases + area_name
      → if best similarity < 0.4, geocode via Photon
      → ST_DWithin(stops.location, geocoded_point, 2000)
      → rank by (text similarity, distance, service frequency)
      → for each stop: serving routes → today's trips → live ETA or scheduled time
```

Results render as: **`Bus 14 · 6 min · running`** / `Bus 22 · 7:40 AM · scheduled` / `Bus 27 · not running today`. Cached 5 minutes in Redis.

**Location pinning:** map-drag pin or one-tap "use my location", coarsened to ~100 m before storage, with a travel-mode selector.

**Walking ETA:** OSRM `foot` (or the chosen profile) from pin to stop, cached in `walk_eta_cache`, refreshed daily and on pin change.

**Per-stop ETA engine** (`engine/eta.ts`): the §5.5 blend, publishing to `trip:{id}:eta` and emitting `eta.update` SSE frames on material change (>30 s).

**Leave-now evaluator:** the 10 s ticker over the `subs_active` partial index, computing the §5.6 comparison and emitting a `leave_now` domain event. *Emits the event only — Stage 6 delivers it.*

**Trip subscription lifecycle:** choose a bus for today, pick a target stop, see a vertical route timeline of progress with your stop highlighted.

**Segment speed learning:** nightly job populating `segment_speeds` from `positions`.

### Components

`gateway/routes/api/search` · `engine/eta.ts` · `walk_eta_cache` · `apps/web/(student)/search` · `(student)/stop/[id]` · `components/eta` · segment-speed job

### Expect

Type "dilsuknagar" (misspelled) and get the right stop with live per-bus ETAs. Pin your home, choose Bus 14 and your stop, and see a correct "leave in 7 minutes" countdown that shortens as the bus approaches.

### Validate ETA accuracy against reality

This is the stage where the product is proven or disproven. Instrument it: for every trip, log predicted vs. actual arrival at each stop. Target **MAE under 90 s at a 10-minute horizon**. If it misses that, tune the §5.5 blend weights — do not proceed to Stage 6 building alerts on an ETA you have not measured.

### Exit criteria

- [ ] Fuzzy search returns correct stops for 20 hand-written misspellings
- [ ] Area search ("Dilsukhnagar") returns all stops within 2 km with serving buses
- [ ] Walking ETA within 20% of a stopwatch-timed real walk
- [ ] Bus ETA MAE < 90 s at a 10-minute horizon over ≥10 real trips
- [ ] `vault/modules/M05-search-eta.md` + `benchmarks/eta-accuracy-v1.md`

---

# Stage 6 — The notification spine

**~7 days. The largest, highest-risk stage. Everything the product promises is delivered here.**

### Build

**Push infrastructure:**

- VAPID keys; service worker `push` and `notificationclick` handlers
- Subscription lifecycle with health tracking; `410` pruning
- **Install prompt UX:** detect iOS Safari without `standalone`, explain plainly why installation is required for alerts, show the Share → Add to Home Screen flow
- MSG91 SMS adapter with delivery receipts

**`engine/notify.ts` — the fan-out pipeline:**

- Tier resolution → audience resolution → per-user filters → dedupe → channel selection → send → receipt (ARCHITECTURE §6.3)
- `dedupe_key` generation and the unique-constraint guard
- Collapse-tag handling so 12 stop updates become one updating notification

**Event wiring — the requested flow, end to end:**

| Event | Audience | Tier |
|---|---|---|
| Trip starts | `main_favourite` holders | **T1 URGENT** |
| Trip starts | `starred` holders | **T3** + *Follow* / *Not today* actions |
| Stop reached | active `trip_subscriptions` past that stop | **T3**, collapsed |
| Leave now | the specific subscriber | **T1 URGENT** (+ SMS if no push) |
| Signal lost (unknown zone) | today's riders | **T2** |
| Signal lost (known zone) | today's riders | **T4**, in-app only |
| Bus out of commission | everyone connected to that bus | **T0 CRITICAL** + SMS |

**Notification actions** — this is what makes the flow work: *Follow* creates a `trip_subscription`; *Not today* sets `favourites.muted_until` to end-of-day **without unstarring**.

**Notification center:** tier-filtered list, unread badges, ticket cards with live status, acknowledgement for T0, infinite scroll.

**Kill switch:** prominent "I'm on the bus" control → 3-hour pause; per-bus mute; quiet hours; minimum-tier preference; T0 breakthrough toggle.

### Components

`packages/notify` · `engine/notify.ts` · `apps/web/public/sw.ts` · `lib/push` · `(student)/notifications` · `(student)/settings` · `push_subscriptions` · `notifications` · `notification_recipients`

### Expect

Star three buses and set one as your main. Start those buses in the simulator: the main one produces an urgent alert, the others a normal one with action buttons. Tap *Follow* on one, and stop-by-stop progress arrives as a single updating notification. When the bus closes on your stop, "Leave now — Bus 14 arrives in 8 min" fires exactly once. Tap "I'm on the bus" and everything goes quiet for three hours.

### Test hardest here

Notification correctness is where this product lives or dies:

- Restart the notify worker mid-fan-out → **zero duplicates**
- Flap a geofence boundary 20 times → **one** arrival notification
- Replay a full day of backfilled pings → **zero** retroactive alerts
- 300 users, one T0 announcement → all delivered within 30 s
- Revoke push permission mid-session → T1 falls back to SMS, notification center still written
- Kill switch active → T3 suppressed, T0 breaks through

### Exit criteria

- [ ] Every adversarial test above passes
- [ ] iOS: installed PWA receives push; uninstalled iOS receives SMS for T0/T1
- [ ] End-to-end alert latency (event → phone buzzes) p95 under 10 s
- [ ] Notification center is written even when every transport fails
- [ ] `vault/modules/M06-notifications.md` + `ADR-0004-tiering-and-dedupe.md` + `runbooks/push-not-delivering.md`

---

# Stage 7 — Admin console

**~6 days. The Transport Department's half of the product.**

### Build

- **Fleet management:** bus CRUD, tracker pairing and secret rotation, driver assignment, route assignment.
- **Status control:** mark a bus out of commission → opens a ticket → fires **T0**; resolve → **T2** "back in service" on the *same* ticket card.
- **Announcements:** rich composer, tier selector with a plain-language explanation of each tier's disruption, **audience selector (All / Juniors / Seniors / Route / Bus)**, live recipient-count preview, schedule-for-later, and a **confirmation dialog that states the exact number of phones that will buzz**.
- **Event-day CSV upload:** drop file → parse → validate bus numbers and routes against the database → **rendered diff (added / changed / removed / unchanged)** → explicit confirm → apply → cohort-segmented T2 notification. `content_hash` blocks a duplicate re-upload from re-notifying.
- **Ticket queue:** open/acknowledged/resolved, assignment, timeline, auto-opened tickets from sustained signal loss.
- **Live fleet dashboard:** every bus's presence state, current trip, last ping age, today's ETA accuracy.
- **Audit log viewer** with before/after diffs.

### Components

`apps/web/(admin)/*` · `engine/roster.ts` (event-day half) · `gateway/routes/api/admin` · `tickets` · `ticket_events` · `announcements` · `roster_uploads` · `event_day_buses` · `audit_log`

### Expect

A TD staff member with no technical background can mark a bus out of commission, write an announcement to first-years only, and publish an event-day bus list from a spreadsheet — and at every destructive step the interface tells them exactly how many people it is about to disturb.

### The design constraint that matters most

**Nothing reaches 300 phones without a preview and an explicit confirmation.** Every publish action shows the rendered notification, the resolved audience count, and a typed confirmation for T0. Institutional trust survives exactly one mass-notification accident.

### Exit criteria

- [ ] A non-technical TD member completes all three core workflows unassisted in a usability session
- [ ] Malformed CSV is rejected at preview with per-row, per-column errors and sends nothing
- [ ] Identical CSV re-upload does not re-notify
- [ ] Every admin mutation appears in `audit_log` with correct before/after
- [ ] `vault/modules/M07-admin-console.md` + `runbooks/csv-upload-failed.md`

---

# Stage 8 — Learning, observability and load

**~5 days. Turning a working system into an operable one.**

### Build

- **Dead-zone learning** (`engine/deadzone.ts`): nightly DBSCAN (ε = 150 m, minPts = 4) over `signal_outages` entry points → buffered convex hulls → `dead_zones` with confidence and expected duration. Classification in the presence sweeper starts consuming them. Admin map overlay of learned zones.
- **OpenTelemetry** end to end: one trace from ingest through snap, ETA, notify, to push receipt. Ship to Grafana Cloud. Sentry for errors on both web apps.
- **Dashboards:** p50/p95 ping-to-pixel latency, ETA MAE by route and hour, notification delivery rate by channel, dead-zone frequency, active SSE connections, stream consumer lag.
- **Alerting:** p95 latency > 8 s for 5 min; consumer lag > 1,000; push failure rate > 10%; any bus DARK > 15 min during a service window.
- **k6 load tests:** 300 concurrent SSE clients + 30 ingest streams + a T0 broadcast at peak; 500-client headroom run.
- **Chaos drills, each documented in a runbook:** kill Redis, kill Postgres, kill a worker mid-fan-out, saturate OSRM, revoke a VAPID key.
- **Optional:** the on-bus auto-detect prompt (ARCHITECTURE §6.5).

### Components

`engine/deadzone.ts` · OTel instrumentation across all apps · `tests/load/*.js` · `vault/runbooks/*` · `vault/benchmarks/*` · admin observability page

### Expect

After two weeks of real running, the system knows where the dead zones are and explains them instead of alarming about them. Under a 300-client load test, p95 ping-to-pixel stays under 6 s and no notification is dropped. Every failure drill has a written runbook with a tested recovery procedure.

### Exit criteria

- [ ] ≥3 dead zones learned and classified correctly on real routes
- [ ] 300-client k6 run: p95 < 6 s, zero dropped notifications, zero stream lag growth
- [ ] 500-client headroom run degrades gracefully rather than collapsing
- [ ] All five chaos drills executed with a written, tested runbook each
- [ ] `vault/modules/M08-observability.md` + `benchmarks/load-300-v1.md`

---

# Stage 9 — Production and hardware

**~5 days plus hardware lead time.**

### Build

- Provision production per ARCHITECTURE §9 (Supabase Pro Mumbai, Fly.io `bom`, Redis, OSRM VPS, Cloudflare).
- Migration and rollback runbooks; automated daily backups with a **tested restore**.
- Domain, TLS, HTTP/2, CSP, security headers.
- **Hardware tracker adapter:** a protocol-decoder service in front of `/v1/ingest` speaking the chosen device protocol and emitting the identical `PingBatch` contract. Everything downstream is untouched — this is what the `tracker_kind` seam was for.
- Staged rollout: 3 buses → measure ETA accuracy for two weeks → 10 buses → full 30.
- Driver onboarding sheet; TD admin handbook; student launch guide.
- Handover documentation for campus IT.

### Expect

The pilot runs on real buses with real students. ETA accuracy is measured against actual arrivals before any fleet-wide hardware spend — exactly the gate the project deck already committed to.

### Exit criteria

- [ ] Production deployed, monitored, backed up, restore tested
- [ ] Two-week pilot with ETA MAE < 90 s on real routes
- [ ] Hardware adapter validated against one physical tracker
- [ ] Handover pack complete
- [ ] `vault/modules/M09-production.md` + `runbooks/deploy.md` + `runbooks/rollback.md`

---

## Per-stage ritual

Every stage ends with the same three steps. They are part of the stage, not admin overhead afterwards:

1. **Vault entry** — `vault/modules/M0X-<name>.md` from `vault/_TEMPLATE.md`: what was built, files and components added, schema changes with migration ids, new env vars, decisions and why, **gotchas and failure modes discovered**, how to verify locally, how to roll back, open items carried forward.
2. **ADRs** — any decision that was genuinely contested gets `vault/decisions/ADR-XXXX-<slug>.md` recording the options, the choice and the consequence. Future-you will want the rejected options, not just the winner.
3. **README update** — Features, Getting Started, Environment Variables, Project Structure and Roadmap kept accurate against what actually works. A README that overstates the current state is worse than no README.

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Drivers won't keep the phone mounted with the screen on | **High** | High | Clear onboarding, a mount and charger per bus, an admin dashboard that shows which buses are not reporting. Escape hatch: Capacitor/TWA wrapper for a real foreground service. |
| DLT registration delays SMS | Medium | High | Started in Stage 0. Fallback: push-only for the pilot, with an explicit in-app warning for un-installed iOS users. |
| TD roster CSV is late, incomplete, or has no phone numbers | **High** | High | Requested in Stage 0. Fallback: admin-created accounts for a pilot cohort; email OTP as a secondary claim channel. |
| ETA accuracy misses the 90 s target on congested routes | Medium | High | Stage 5 gates on this explicitly. Levers: tune blend weights, shorten segment buckets, widen the displayed range, raise the leave-now buffer. |
| Notification fatigue → students disable push | Medium | **Critical** | Tiering, collapse tags, per-bus mute, quiet hours, kill switch, and a strict default of T3-and-above only. |
| iOS users never install the PWA | **High** | Medium | Install prompt with a plain explanation, SMS fallback for T0/T1, and a persistent in-app banner while alerts are undeliverable. |
| Route changes mid-semester invalidate geometry | Medium | Medium | Route versioning (never edit in place) + the admin editor makes a re-survey a one-hour job. |
| Scope creep into a native app | Medium | Medium | The brief says web app. Hold the line; the only native surface ever considered is the optional *driver* wrapper. |
