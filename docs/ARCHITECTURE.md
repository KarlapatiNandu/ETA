# Bus Mitra — Architecture

> Reference document for the technical design. Read this before writing code in any module.
> Companion documents: [SCHEMA.md](SCHEMA.md) (data model), [BUILD_PLAN.md](BUILD_PLAN.md) (staged delivery).

---

## 1. The shape of the problem

Before choosing anything, be honest about the numbers:

| Dimension | Value at full fleet | Implication |
|---|---|---|
| Buses reporting | 30 | the deck costed 25; 30 is the planning number, and the gap is headroom, not a discrepancy to resolve later |
| Ping interval (moving) | 5 s | **6 writes/sec ingest** |
| Ping interval (idle) | 15 s | negligible — and see §5.7: presence thresholds are derived from this, not hard-coded |
| Riders (fleet capacity) | ~1,500 | 30 buses × ~50 seats |
| Concurrent students (peak) | **600** | see below |
| Live fleet state | 30 × ~120 bytes | **~4 KB — fits in L2 cache** |
| Positions/day | 30 × 4 h × 720/h | ~86 k rows/day, ~19 M/yr over ~220 service days |
| Notifications/day | ~600 users × ~6 | ~3,600 sends/day |

⚠️ **The concurrency number is the assumption most likely to be wrong, and everything downstream inherits it.** The app exists to answer one question at one moment — 7:40 a.m., when every rider is deciding whether to leave. Peak concurrency is therefore *not* a modest fraction of the user base; it approaches all of it. 600 is ~40% of fleet capacity in the peak minute. Load targets are set at 600 with a 1,000-client headroom run (§Stage 8).

**Confirm the real number before Stage 8** by asking the Transport Department for actual daily ridership. If it is materially above 1,500, the SSE fan-out and the Fly.io sizing both need re-deriving — and it is far cheaper to learn that from a spreadsheet than from a load test.

**This is not a big-data problem.** Six writes per second is nothing. The entire live state of the fleet is four kilobytes. A single Node process could serve this many times over, even at 600 concurrent readers.

What this *is*, is a **low-latency, high-correctness, high-fan-out-fairness** problem. The failure modes that kill this product are not throughput failures:

1. A student gets a "leave now" alert **90 seconds late** and misses the bus. The app is worse than useless — it was trusted and it lied.
2. A student gets the **same stop notification twice**, or gets 12 stacked notifications for 12 stops. They disable notifications permanently. Retention is gone.
3. A bus enters a dead zone and the map shows it **frozen at a stale position** that looks live. The student waits at a stop for a bus that passed ten minutes ago.
4. The Transport Department uploads a malformed CSV and **300 phones buzz with garbage**. Institutional trust is gone and it does not come back.

Every architectural decision below is made to prevent one of those four, not to handle load. **Design for correctness under degradation, and the scale takes care of itself.**

### The core inversion

The naive architecture writes every GPS ping to the database and has clients read from the database. That couples ingestion to delivery, puts disk I/O and replication lag on the hot path, and means a read spike at 4 p.m. (when every student opens the app) degrades GPS collection.

Bus Mitra inverts this:

> **The database is never on the read path for live data.**
> Postgres is the system of record and the analytics store. Redis is the live fleet. Clients read Redis-derived state pushed over SSE. Persistence to Postgres happens on a separate, batched, lagging consumer that no student ever waits on.

If Postgres goes down mid-route, the live map keeps working. That property is not a nice-to-have; it is the design.

---

## 2. Tech stack

### 2.1 Decisions

| Layer | Choice | Why this and not the obvious alternative |
|---|---|---|
| **Monorepo** | pnpm workspaces + Turborepo | Four deployables share one contract package. Type errors surface at build time across the ingest → engine → client boundary. |
| **Language** | TypeScript 5.7, `strict`, everywhere | One language across driver app, gateway, workers, web. Shared Zod schemas mean the CSV parser, the ingest validator and the client form all enforce the same rules from one definition. |
| **Student + Admin web** | Next.js 15 (App Router) + React 19 | Server Components for the static shell (fast first paint on 4G), client islands for the map. Route groups keep student and admin in one deploy with role-gated middleware. |
| **Driver app** | Separate Vite + React PWA | Must be a *tiny*, dependency-light bundle that boots on a cheap Android phone on a weak connection. Bundling it into Next.js would drag the whole student app's JS along. A separate origin also means a driver's service worker can never conflict with a student's. |
| **PWA / service worker** | Serwist | Actively maintained successor to `next-pwa`. Needed for installability (iOS push requires it), the offline shell, and the `push` / `notificationclick` handlers. |
| **Styling** | Tailwind CSS v4 + shadcn/ui + Framer Motion | See §8 for the visual direction. shadcn gives accessible primitives we own the source of, rather than fighting a component library's opinions. |
| **Map** | MapLibre GL JS + **self-hosted vector tiles** (OpenMapTiles/Planetiler, Hyderabad extract, served from the OSRM box) | MapLibre is free and open; vector tiles let us restyle to the app theme instead of accepting Google's grey, and GPU rendering makes 30 animated markers cost nothing. Mapbox GL went proprietary at v2; MapLibre is the fork that stayed open. **Tiles are self-hosted — see ADR-0005 below.** |
| **Client state** | TanStack Query + Zustand | Query for REST/cached server state (stops, routes, notification history), Zustand for the live SSE-fed fleet store. Do not put streaming positions in Query — it is a cache, not a stream. |
| **API + realtime** | Fastify 5 on Node 22, native **SSE** | See ADR-0001 below. |
| **Hot state** | Redis 7 — Hashes, Streams, TTL keys | Sub-millisecond fleet state. Streams give durable, replayable ingest with consumer groups, so the persister can lag or crash without dropping pings. |
| **Background jobs** | BullMQ | Retries with backoff, rate limiting, repeatable jobs for the sweepers. Notification sends must never run inline on a request. |
| **Database** | Supabase Postgres 15 + PostGIS + pg_trgm + pgcrypto | Geospatial queries, fuzzy stop search, auth, storage and row-level security in one system. See §9 for the production migration answer (spoiler: don't migrate). |
| **ORM** | Drizzle | SQL-first, so raw PostGIS expressions stay readable. Generates types from the schema. Migrations are plain SQL files we can review. |
| **Routing / geo engine** | OSRM, self-hosted, Hyderabad bbox clipped from the Telangana extract (OpenStreetMap France mirror) | `car` profile for bus travel times and route derivation, `foot` profile for student walk-to-stop ETAs. Free, runs locally, no per-request billing, works offline in dev. |
| **Geocoding** | Photon (self-hosted), MapTiler Geocoding as fallback | Needed so "Dilsukhnagar" resolves to an *area* even when it is not a stop name. |
| **Web push** | `web-push` (VAPID) | Direct to the browser push services. No Firebase dependency and no vendor lock-in for a web app. |
| **SMS fallback** | MSG91 (India, DLT-registered) | Guarantees URGENT/CRITICAL tiers land on iPhones that skipped the PWA install. ⚠️ **DLT registration is a 1–2 week regulatory process — start it in Stage 0.** |
| **Validation** | Zod | Single source of truth for ingest payloads, API contracts, SSE events, env vars and CSV columns. |
| **Observability** | OpenTelemetry → Grafana Cloud (free tier) + Sentry | One trace ID from GPS ping to push delivery. Without this, debugging "why was my alert late" is guesswork. |
| **Testing** | Vitest (unit), Playwright (e2e), k6 (load) | The geo package is pure functions and must have near-total unit coverage — it is where silent wrongness lives. |
| **CI** | GitHub Actions | Typecheck, test, migration-drift check, preview deploy. |

### 2.2 ADR-0001 — SSE, not WebSocket, not Supabase Realtime

**Context.** Students need live positions, ETAs and notifications pushed to an open tab.

**Options considered:**

- **WebSocket.** Bidirectional, but we have almost no client→server traffic on the live path (focus changes and mutations are fine as ordinary REST calls). In exchange we take on: manual reconnect/backoff logic, heartbeat/ping-pong framing, sticky sessions or a shared adapter behind any load balancer, and proxies that silently drop idle upgrades.
- **Supabase Realtime (`postgres_changes`).** Every position would have to be written to Postgres, replicated through the WAL, decoded and broadcast — adding 200–800 ms and **re-coupling ingestion to delivery**, the exact thing we are avoiding. Supabase Realtime Broadcast skips the write, but routes through their Phoenix cluster with no control over per-user payload shaping — and we need that, because each student's stream carries *their* stop's ETA, not everyone's.
- **SSE (`text/event-stream`).** One-way, which is exactly the shape of the problem. Native `EventSource` reconnection with `Last-Event-ID` resumption is built into every browser. Plain HTTP, so it traverses every corporate proxy and campus firewall. Trivially debuggable with `curl`.

**Decision: SSE.** Over HTTP/2 the old six-connections-per-origin limit does not apply, and we terminate TLS with HTTP/2 enabled.

**Consequence:** the SSE endpoint must live on the long-lived Fastify gateway, **never** on a Next.js API route deployed to a serverless platform — those have execution-time caps that will sever the stream.

**We still use Supabase Realtime** for low-frequency admin state (fleet status edits, ticket transitions) inside the admin console, where its convenience is worth it and latency does not matter.

### 2.3 ADR-0005 — Self-hosted tiles, not a tile SaaS free tier

**Context.** MapLibre renders tiles; it does not serve them. The deck's cost model lists map tiles at ₹0, which is only true if we host them.

**The arithmetic that forces the decision.** 600 peak users, ~2 sessions each per weekday, ~150–250 tile requests per map session, ~22 service days: **≈ 4–6 million tile requests per month.** Every hosted tile free tier is in the 100 k/month range — MapTiler's included. At that volume a SaaS plan is a recurring four-figure-rupee line item that the deck never budgeted, and it scales with adoption, which is the wrong direction for a cost to move.

**Decision: self-host.** A Hyderabad-bbox extract rendered once with Planetiler produces an `.mbtiles` file in the low hundreds of MB, served by `tileserver-gl` or straight from object storage as PMTiles behind Cloudflare. It sits on the OSRM box, which is already provisioned and idle between routing calls. Cloudflare caches the tiles at the edge, so origin load is negligible.

**Consequence.** One more service to build and monitor in Stage 0, and tiles go stale until the extract is re-rendered (a quarterly cron job — campus roads do not move). In exchange, the tile bill is genuinely ₹0 and stays ₹0 as usage grows.

**Rejected:** MapTiler/Stadia paid tiers (recurring cost that grows with adoption), raster OSM tiles from the public `tile.openstreetmap.org` (forbidden by their tile usage policy for an application, and raster cannot be restyled to the theme).

### 2.4 ADR-0002 — Redis as the live fleet, Postgres as the record

Redis holds authoritative *current* state; Postgres holds authoritative *historical* state. On engine boot (the engine owns every write to `fleet:live`), Redis is rehydrated from the last 5 minutes of `positions` so a restart does not blank the map. Each rehydrated bus is written with the presence its age already implies, so a four-minute-old fix comes back DARK, not LIVE, and nothing newer is ever overwritten. Redis persistence is AOF `everysec` — losing one second of live positions on a hard crash is acceptable because the next ping is five seconds away.

---

## 3. System topology

```
┌───────────────────────────────────────────────────────────────────────────┐
│  CAPTURE                                                                  │
│                                                                           │
│  Driver PWA (pilot)          │  Hardware tracker (fleet stage)            │
│  • Geolocation watchPosition │  • ESP32 / commercial unit, battery-wired  │
│  • Screen Wake Lock          │  • Flash ring-buffer                       │
│  • IndexedDB offline buffer  │  • Ignition-driven trip start              │
│  • Batch POST every 5 s      │                                            │
└──────────────┬────────────────────────────────┬───────────────────────────┘
               │  POST /v1/ingest  (HMAC-signed, batched, replay-safe)
               ▼                                ▼   (adapter — same contract)
┌───────────────────────────────────────────────────────────────────────────┐
│  GATEWAY — Fastify (stateless, horizontally scalable)                     │
│                                                                           │
│   /v1/ingest ──► validate ──► dedupe ──► XADD stream:pings                │
│   /v1/stream ──► SSE fan-out, per-user subscription set                   │
│   /v1/api/*  ──► REST: search, favourites, profile, admin                 │
└──────────────┬───────────────────────────────────┬────────────────────────┘
               │ Redis Stream (consumer groups)     │ reads Redis + Postgres
               ▼                                    │
┌──────────────────────────────────────────┐        │
│  ENGINE — BullMQ workers                 │        │
│                                          │        │
│  geo-worker    snap → progress → speed   │        │
│  geofence      route-crossing arrivals   │        │
│  eta-worker    per-stop + per-student    │        │
│  presence      5 s sweeper: LIVE/DARK    │        │
│  notify        tier → dedupe → fan-out   │        │
│  persister     batched COPY to Postgres  │        │
│  roster        CSV parse → diff → apply  │        │
│  deadzone      nightly DBSCAN clustering │        │
└──────┬─────────────────────┬─────────────┘        │
       │                     │                      │
       ▼                     ▼                      ▼
┌─────────────┐   ┌────────────────────┐   ┌──────────────────┐
│   Redis     │   │  Web Push / MSG91  │   │ Supabase Postgres│
│ fleet state │   │  SMS (T0/T1 only)  │   │ PostGIS + RLS    │
│ streams     │   └────────────────────┘   │ system of record │
│ BullMQ      │                            └──────────────────┘
└─────────────┘                                      ▲
       ▲                                             │
       │              ┌──────────────┐               │
       └──────────────│    OSRM      │───────────────┘
                      │ car + foot   │
                      └──────────────┘
```

**Why the engine is separate from the gateway:** the gateway must never block. If ETA recomputation gets slow (an OSRM call times out, a route has 4,000 vertices), it must not add a millisecond to the SSE fan-out or the ingest ack. Separate process, separate failure domain, separate scaling knob.

---

## 4. The latency budget

The deck targeted ~8 s pipeline, ~23 s worst-case staleness. With a phone-based tracker at a 5 s cadence we can do materially better.

| Hop | Budget | Notes |
|---|---|---|
| GPS fix → app callback | ~1 s | `watchPosition`, `enableHighAccuracy: true` |
| Batch hold | 0–5 s | ping cadence; average 2.5 s |
| Uplink (4G, Hyderabad) | 150–400 ms | p95 on a loaded cell |
| Gateway: validate + `XADD` | < 10 ms | no DB, no network beyond Redis |
| Engine: snap + progress + ETA | < 20 ms | in-memory polyline, windowed search |
| Redis pub → SSE frame written | < 20 ms | |
| Client: parse + interpolate + paint | < 50 ms | GPU-composited marker transform |
| **Pipeline total (excl. cadence)** | **≈ 0.5 s** | |
| **p50 end-to-end staleness** | **≈ 3 s** | half cadence + pipeline |
| **p95 end-to-end staleness** | **≈ 6 s** | |
| **Worst case (one dropped ping)** | **≈ 11 s** | then DEGRADED state is shown honestly |

**Guardrail:** every stage emits an OTel span. If p95 staleness exceeds 8 s for five consecutive minutes, an alert fires. A tracking app that silently degrades to 30 s latency still *looks* like it works — which is exactly why it must be measured, not assumed.

### Perceived latency

Real latency is 3 s; **perceived** latency should be zero. The client dead-reckons: between pings it advances the marker along the known route polyline at the last reported speed, easing to the true position when the next ping lands. The bus glides instead of teleporting. This is the single highest-leverage UI detail in the product and costs about forty lines of code.

Dead reckoning has hard limits, because it is the one place the client draws a position nobody reported (invariant: never fabricate). It extrapolates **only a LIVE bus**, **at most two cadences past its last fix** (10 s at the moving cadence), and never past the end of the route. A DEGRADED or DARK bus is drawn at its last true fix. Off-route, the marker eases to the reported point and never runs ahead. (`apps/web/lib/map/interpolate.ts`.)

---

## 5. Core algorithms

These live in `packages/geo` as pure, deterministic, heavily-tested functions. No I/O, no clock reads — every one takes its inputs explicitly so it can be replayed against recorded traces.

### 5.1 Route representation

A route is a polyline of `N` vertices with a precomputed array of cumulative distances `D[0..N-1]`, `D[0] = 0`. Built once at route-publish time, cached in Redis and in worker process memory. Every position on the route is then a single scalar: **route offset `s`**, in metres from the origin.

Reducing a 2-D tracking problem to a 1-D scalar is what makes everything downstream cheap and robust.

**Route versions and route lineage.** A published route is immutable; correcting it creates `version + 1` as a *new row with a new id*, so historical trips still resolve the geometry they actually ran. But everything the system *learns* — segment speeds, dead-zone polygons, dwell times — is keyed by route, and keying it by the versioned `id` would mean **every route correction silently resets the traffic model and the learned dead zones to cold start.** Moving one stop 50 m would cost a semester of accumulated history.

Every route therefore carries a stable `lineage_id` that survives versioning. Operational data keys on `id` (what ran); learned data keys on `lineage_id` (what we know about this road). A re-survey that changes geometry by metres keeps its history; a genuinely new route gets a new lineage and starts cold, correctly.

### 5.2 Snapping (raw GPS → route offset)

```
snap(ping, route, lastIndex):
  window = lastIndex is known ? [lastIndex - 20, lastIndex + 80] : [0, N]
  for each segment in window:
     project ping onto segment, keep perpendicular distance
  best = segment with minimum perpendicular distance

  if best.perpDistance > OFF_ROUTE_THRESHOLD (75 m):
     if sustained for 3 consecutive pings → emit OFF_ROUTE, stop trusting offset
     else → treat as GPS noise, hold previous offset
  s = D[best.index] + projectionLengthAlongSegment
```

The forward-biased window assumes monotonic progress, making the common case O(100) instead of O(N) — and, more importantly, prevents a bus on a route that loops back near itself from snapping to the wrong pass.

### 5.3 Progress monotonicity

GPS jitter makes raw offsets oscillate. Enforce:

```
if s_new < s_prev - BACKWARD_TOLERANCE (30 m):  reject, keep s_prev, backwardRun++
if s_new - s_prev > maxPlausibleJump(dt):       reject as a GPS spike
else:                                           accept, backwardRun = 0

-- recovery: a genuine reversal is not jitter
if backwardRun >= 4 consecutive pings:
     discard the window hint, re-snap globally over [0, N]
     reset trip:{id}:seq to the stop index implied by the new offset
     emit TRIP_RESNAPPED (audit + admin console), suppress ETAs for one cycle
     backwardRun = 0
```

Without the rejection rule, a stop can "arrive" twice as the offset jitters across its boundary. This is the root cause of duplicate-notification bugs in most naive implementations.

⚠️ **Without the recovery rule, the opposite bug appears and is worse.** A U-turn, a missed turn, or a driver who starts the trip mid-route moves the bus genuinely backwards *along the route geometry* — perpendicular distance stays near zero, so `OFF_ROUTE` never fires, and the offset freezes for the remainder of the trip while every downstream ETA silently rots. Four sustained backward pings is well outside GPS jitter (σ ≈ 8 m against a 30 m tolerance) and unambiguously means the bus really did reverse. Re-snap, do not hold.

### 5.4 Stop arrival — crossing, not circles

**The naive approach fails.** At 60 km/h with a 5 s cadence, consecutive pings are 83 m apart. A circular 80 m geofence is missed entirely, roughly half the time.

Use **route-offset crossing** instead. Stop `k` sits at offset `D_k`:

```
arrived(k)  ⟺  s_prev < D_k ≤ s_now
                AND k == expectedNextStopIndex(trip)          -- sequence enforced
                AND minPerpDistanceToStop(recent pings) < 150 m  -- not a detour

confirm arrival when:  speed < 8 km/h within ±60 s   (bus actually stopped)
                  OR:  s_now ≥ D_k + 100 m           (bus drove straight through)

departed(k) ⟺ confirmed arrival AND speed > 12 km/h AND s_now > D_k + 50 m

skipped(k)  ⟺  k == expectedNextStopIndex(trip)
                AND s_now > D_k + 300 m        -- bus is decisively past it
                AND no arrival was ever confirmed for k
             → write trip_stop_events(event = 'skipped', source = 'inferred')
             → advance trip:{id}:seq past k
```

⚠️ **The `skipped` rule is not optional bookkeeping — it is what stops one bad stop from poisoning the whole trip.** Because `arrived(k)` requires `k == expectedNextStopIndex`, a single unconfirmed stop would otherwise block stops *k+1 … N* for the rest of the run: no arrival events, no progress notifications, and a route timeline frozen at stop 4 while the bus is at stop 11. Detours, a driver skipping an empty stop, and a dead zone spanning a stop all produce this. Advancing the sequence on a decisive pass-by is the release valve.

Sequence state lives in `trip:{id}:seq` and only ever increases. Every emitted event writes to `trip_stop_events` with a `UNIQUE (trip_id, seq, event)` constraint (keyed on `seq`, not `stop_id`, so a route may legitimately serve the same stop twice) — so the database is the final idempotency backstop even if a worker is replayed.

### 5.5 ETA

Three inputs, blended, degrading gracefully as history accumulates:

```
For each segment between current offset s and target stop offset D_k:

  v_hist  = rolling median speed, resolved down the fallback ladder below
  v_live  = EWMA of recent observed speed, α = 0.3
  v_osrm  = OSRM's free-flow expected speed for that geometry

  v_expected = 0.55·v_hist + 0.35·v_live + 0.10·v_osrm     (v_hist resolved)
             = 0.60·v_osrm·congestionFactor + 0.40·v_live  (no rung had samples)

  where congestionFactor = clamp(v_live / v_osrm_here, 0.3, 1.2)
  clamp v_expected to [5, 60] km/h

ETA_k = Σ (segmentLength / v_expected) + Σ expectedDwell(intermediate stops)
```

**The `v_hist` fallback ladder.** Take the first rung with `sample_count ≥ 5`:

```
1. (lineage, segment, weekday, tod_bucket)     -- exact
2. (lineage, segment, weekdayClass, tod_bucket) -- weekday vs weekend
3. (lineage, segment, tod_bucket)               -- any day
4. (lineage, segment)                           -- any time
5. none  →  fall through to the cold-start blend above
```

⚠️ **Rung 1 will almost never be populated, and the design has to assume that.** A route runs ~2 trips a day. Keyed by weekday *and* a 15-minute bucket, each exact cell accumulates roughly **one sample per week** — so "history exists" would not engage until well into a second semester. Without the ladder the system is permanently in cold start while *appearing* to have a learned traffic model, which is the worst of both. The ladder means a route has usable history within about a fortnight (rung 3–4) and sharpens toward rung 1 over a term.

`expectedDwell` is the historical median of `departed − arrived` per stop, defaulting to 30 s.

**Report a range, not a point.** Segment speed variance gives a p90. The UI shows "4–6 min" with a confidence dot. A single confident number that is wrong destroys trust faster than an honest range ever will.

**As built (Stage 5, `apps/engine/src/workers/eta.ts`).** A consumer group `eta` on `stream:events` recomputes the range to every stop still ahead of the bus on each accepted position, and writes `trip:{id}:eta`. `v_hist` resolves per segment for the weekday and quarter-hour **in IST**. `v_osrm` is OSRM car free-flow per 200 m segment, fetched once per route version by routing through the route's own points every 200 m and cached for a day. A leg more than three times the segment length snapped onto the far carriageway and is ignored. `v_live` is the bus's EWMA. Confidence is the share of the remaining distance covered by learned history: high ≥ 80 %, medium ≥ 30 %, low otherwise. So a new route honestly says *low* until it has history.

- **Announced only on material change.** An `eta.update` goes out (over `pubsub:eta`, to the connections watching that stop) when p50 differs by more than 30 s from what the last announcement's countdown now predicts. Between announcements the client counts down from `at`, the fix time.
- **Withdrawn, never left to rot.** Off-route, the one cycle after a re-snap (§5.3), DARK and ENDED all delete the trip's ETAs and send `withdrawn: true`. A stop the bus has passed is dropped from the hash the same way.
- **Measured.** One prediction per stop is logged to `eta_predictions` as p50 enters each of the 10-, 5- and 2-minute buckets. The actual arrival is filled in from `trip_stop_events`, and MAE at the 10-minute horizon is the Stage 5 gate.
- **History is cached per lineage for ten minutes on the wall clock**, never on the fix's timestamp. An older (replayed, backfilled) fix would otherwise make a stale cache look fresh.

### 5.6 "Leave now" — the highest-stakes computation in the product

```
leaveNow  ⟺  ETA_bus→stop  ≤  studentTravelTime + safetyBuffer

studentTravelTime = OSRM foot (or the user's chosen mode) duration
                    from pinned location → chosen stop
                    cached per (user, stop), refreshed daily

safetyBuffer = userPreference (default 180 s)
             + (ETA_p90 − ETA_p50)      -- adaptive: noisier route ⇒ earlier alert
```

Fires **exactly once** per `(user, trip, stop)`, guarded by `trip_subscriptions.notified_departure_at` *and* a unique `dedupe_key`.

Evaluated by a ticker every 10 s that iterates only *active* subscriptions — at most a few hundred rows, every value already in Redis. The whole pass is sub-millisecond.

**Asymmetric error handling.** Being 2 minutes early costs a student 2 minutes of waiting. Being 30 seconds late costs them the bus and an hour of their day. The buffer is therefore deliberately generous, and **`safetyBuffer` grows automatically when ETA confidence is low.**

**As built (Stage 5, `apps/engine/src/workers/leave-now.ts`).** The ticker reads the `subs_active` rows from Postgres every 10 s and everything else from Redis. It fires only from a current picture: the bus must be **LIVE** on that trip, and the ETA must come from a fix no older than two cadences plus 10 s. A DEGRADED bus waits for its next fix, and a DARK bus has no ETA at all. The remaining time is `p50 − (now − at)`. Firing is a compare-and-set, `UPDATE … SET notified_departure_at = now() WHERE notified_departure_at IS NULL RETURNING`, so the database decides who fires (invariant 5). Only then is a `leave_now` event appended to `stream:notify`. **Stage 5 emits the event; Stage 6 delivers it.** With Postgres down the ticker does nothing, deliberately: an alert that could fire twice is worse than one that waits for the gate. On the same pass, subscriptions to ended trips become `completed`, and one whose bus reached the stop before the alert could fire becomes `missed`.

The web app shows the same comparison as a countdown: *leave in* = remaining p50 − travel time − buffer − (p90 − p50). The number on screen and the alert agree by construction.

### 5.7 Dead-zone detection and learning

This is an explicit product requirement and deserves more than a timeout.

**Presence state machine**, driven by a 5 s sweeper over `fleet:live`. Thresholds are **multiples of the tracker's current reporting cadence**, never absolute seconds:

| State | Condition | Map | Notification |
|---|---|---|---|
| `LIVE` | age < 3 × cadence | solid marker | — |
| `DEGRADED` | 3 × cadence ≤ age < 9 × cadence | amber, "last seen 34 s ago" | none — avoid alarm fatigue |
| `DARK` | age ≥ 9 × cadence | red, frozen at last known, explicit timestamp | see classification below |
| `ENDED` | explicit trip end, or DARK > 10 min | **removed from map** | explicit end: trip closed. Timeout: see below |

So a moving bus (5 s cadence) goes amber at 15 s and red at 45 s; a stationary one (15 s cadence) at 45 s and 135 s.

⚠️ **Absolute thresholds are a bug here, not a simplification.** The tracker throttles to a slower cadence when stationary (§1). A fixed 25 s DEGRADED line is *below* the idle cadence, so every bus would flash amber at every stop — a healthy fleet rendered as a failing one, several times per trip, which is exactly the alarm fatigue the state machine exists to prevent. Deriving the thresholds from cadence makes the state mean "this tracker missed pings it owed us," which is the thing we actually care about.

**This requires a contract change:** every `PingBatch` carries `cadence_s`, the interval the tracker is currently reporting at. The gateway writes it into `fleet:live` alongside the position, and the sweeper reads it. A batch without it is treated as 5 s.

⚠️ **The advertised cadence is a promise, and the tracker must keep it across a cadence change.** When a bus has stood still for 30 s the tracker slows from 5 s to 15 s. If the next ping then waits the new 15 s, the last ping on record still says 5 s, and the bus reads as three missed pings: amber at every stop, the exact false alarm this section exists to prevent. So the next ping is due at the *sooner* of the current cadence and the cadence the previous ping was sent with (`pingDue` in `packages/contracts/src/tracker.ts`). Speeding up is never delayed. Found while building Stage 3; the driver app and the simulator both carry the rule, and a simulator property test checks that no gap ever exceeds what the previous fix advertised.

⚠️ Do not rely on Redis key-expiry notifications for this — they are lazy and best-effort. Run an explicit sweeper.

**ENDED by timeout removes the bus from the map, but does not close the trip.** The trip row stays `dark` and the live entry is flagged `dark_timeout`. A tracker that comes back — a phone that died and restarted, a long tunnel — is a bus that is really there, so its next fix puts it back on the map. An explicit END is final: buffered pings flushed after it can never resurrect the bus. The trip is closed by the driver's END, or by the bus's next START (`one_live_trip`).

Every sweeper write is a **compare-and-set on the fix it judged**: a ping that lands mid-sweep wins, and a transition already made is never announced twice, so two sweepers are harmless. Postgres is written only on transitions (`signal_outages`, `trips.status`), and never gates them: with the database down, buses still turn amber and red on time, and the outage row is written when it returns.

**Classification on entering DARK** — the part that makes this intelligent:

```
if lastKnownPosition ∈ a known dead_zones polygon:
    → "Bus 14 is in a known dead zone near Uppal flyover.
       Usually clears in about 90 seconds."
    → tier T4 AMBIENT — in-app only, NO push
else:
    → "Signal lost from Bus 14 near <nearest landmark>."
    → tier T2 IMPORTANT — push to today's riders of that trip + admin console
    → open an automatic ticket if it persists past 5 minutes
```

*As built (Stage 7, `apps/engine/src/workers/tickets.ts`):* every 30 s, an open `signal_outages` row outside any known dead zone, older than five minutes, **on a trip that is still running or dark**, becomes one `signal_lost` ticket (`one_open_signal_ticket`). It resolves itself when the bus reports again ("signal came back after 7 min") or when the trip ends while still silent. The ticket is paperwork for the TD; it notifies no student — the T2 comes from the presence transition itself (Stage 6).

**Learning the dead zones.** Every `DARK → RECOVERED` transition writes an outage record with entry point, exit point and duration. A nightly job runs DBSCAN (ε = 150 m, minPts = 4) over outage entry points, builds a buffered convex hull, and writes a `dead_zones` polygon with `confidence` and `avg_outage_s`.

After roughly two weeks of operation the system knows every dead zone on every route, and stops alarming about the ones that are normal. **A recurring outage becomes a predicted, explained event rather than a scary red banner** — that is the difference between a system students trust and one they learn to ignore.

**Backfill rules** (buffered pings flushed on reconnect). The gateway marks a ping `is_backfill = true` when `ingested_at − recorded_at > 30 s`. Backfill pings:

- ✅ **are** persisted to `positions`, filling the historical trail on the map
- ✅ **do** feed segment speed history
- ✅ **do** write `trip_stop_events` with `source = 'inferred'`, so trip history is complete
- ❌ **never** overwrite `fleet:live` if a newer ping already exists
- ❌ **never** fire notifications retroactively — nobody should be told to leave for a bus that passed eight minutes ago

That last rule is non-negotiable and is the most common way this class of system embarrasses itself.

---

## 6. The notification spine

Everything the product promises is delivered here. It gets a dedicated worker, a dedicated schema and a dedicated test suite.

### 6.1 Tiers

| Tier | Name | Channels | Behaviour |
|---|---|---|---|
| **T0** | `CRITICAL` | Push (high) + **SMS** + persistent in-app | Bus out of commission, route cancelled. Requires acknowledgement. Never auto-expires. Bypasses the kill switch by default. |
| **T1** | `URGENT` | Push (high) + **SMS if no live push subscription** | "Leave now." Favourite bus activated. Expires when the event passes. |
| **T2** | `IMPORTANT` | Push (normal) | Roster published, TD announcement, delay > 15 min. |
| **T3** | `INFO` | Push (normal, **collapsible via `tag`**) | Stop reached, recovered from dead zone. |
| **T4** | `AMBIENT` | In-app only | ETA drift, minor status. Notification center only. |

**The `tag` detail matters enormously.** A 12-stop route would otherwise produce 12 stacked notifications. All T3 stop-progress notifications for one trip share `tag: "trip-{id}-progress"` with `renotify: false` (hyphens, not colons: a tag is not a Redis key, and the key-registry guard would rightly flag one that looks like it), so each *replaces* the last. The student sees one notification that keeps updating: "Bus 14 — now at Dilsukhnagar, 3 stops away." T0 sets `requireInteraction: true`.

### 6.2 Idempotency

Every notification carries:

```
dedupe_key = sha256(user_id | event_type | bus_id | stop_id | service_date | content_hash)
```

with a `UNIQUE` constraint. A worker restart, a BullMQ retry, or a geofence flap **cannot** double-notify. This is enforced at the database level, not in application logic, because application logic is exactly what fails at 7:40 a.m.

### 6.3 Delivery pipeline

```
event → tier resolution → audience resolution → per-user filters
      → dedupe check → enqueue → channel adapter → delivery receipt
```

**Per-user filters, applied in order:**

1. `profiles.alerts_paused_until > now()` → suppress (unless T0 and the user has not opted out of critical breakthrough)
2. `favourites.muted_until > now()` for that bus → suppress
3. `tier > profiles.max_tier` → suppress (default `max_tier = 3`, so T4 AMBIENT stays in-app)
4. Quiet hours → defer non-T0 to the next window

**Channel selection:**

```
for each recipient:
  if has a healthy push subscription                → web push (await the HTTP response)
  if tier ≤ T1 and (no push subscription
                    OR every subscription unhealthy
                    OR the push POST returned non-2xx) → SMS, immediately
  always                                            → write to notification center
```

⚠️ **There is no "wait and see if push arrived" step, because Web Push gives you no delivery receipt.** A `201 Created` means the push *service* accepted the message for delivery — not that the phone rendered it. The only failure signal that exists is the HTTP status of our own POST, and that is synchronous. Any waiting period before falling back to SMS would therefore buy zero additional information while spending the alert-latency budget outright: the p95 event-to-buzz target is 10 s (Stage 6), and a T1 "leave now" that arrives late is the exact failure this product cannot have. Decide on the response, send both if in doubt — a duplicate "leave now" across two channels is a far cheaper error than a late one.

Note that **the notification center is written unconditionally**, regardless of push success. The in-app history is the source of truth; push and SMS are best-effort transports on top of it.

**Push subscription health:** a `410 Gone` or `404` from the push service permanently deletes the subscription. Repeated `429`s back off per endpoint. `failure_count ≥ 5` marks it unhealthy and promotes SMS eligibility.

**As built (Stage 7) — how a send is confirmed, and how it reaches this pipeline.**

- *The confirmation is enforced by the gateway, not trusted to the UI* (invariant 11). Every request that notifies anyone — an announcement, out of commission, back in service, an event-day apply with changes — carries `confirm_count`, the number on the dialog. The gateway re-resolves the audience with the same resolver the notify worker will use (`apps/engine/src/lib/audience.ts`) and answers `409 count_changed` with the new number if it moved, `428` if the count is missing, and for T0 `428` unless the count is also typed out. The dialog shows the new number and asks again; it never retries past it.
- *The row is the outbox; `stream:notify` is a doorbell.* The gateway commits the row (announcement, ticket, applied upload) and only then appends `{type, id}` to `stream:notify`. The notify worker reads the truth from the row, so a doorbell for a row that never committed is dropped, and a doorbell lost to a Redis blip is recovered by the worker's sweep over rows that were published but never delivered (Stage 6). A Redis failure after commit is logged, never turned into an error for a change that has already happened. Ringing inside the transaction was rejected: the worker can read the doorbell before the commit is visible and drop a real notification.

**As built (Stage 6, `apps/engine/src/workers/notify.ts`).**

- *Plan → record → deliver.* Each event becomes a plan (tier, audience, text, how long it stays news) in `lib/notify-plans.ts`. **Record** writes the parent and every recipient row in one transaction, idempotent on `notifications.source_key` and `notif_dedupe`; this is the notification center and it happens before any transport (invariant 14). **Deliver** claims due rows with a compare-and-set on `sent_at IS NULL` and then tries push, then SMS. A replayed event, a retried batch or a restarted worker finds its rows and adds nothing; a crash between a claim and its send can cost that student a buzz, never a second one.
- *Filters decide the channel, never the record.* `packages/notify/src/tiers.ts` `decide()` applies §6.3's filters in order. Suppressed students get a center entry marked `inapp_only` with the reason; quiet hours defer the transport to the window's end.
- *News has a shelf life.* A leave-now older than 2 min, a trip start older than 5 min, and stop/signal events older than 2 min never buzz (the latter are not recorded at all); admin sends reach the center but not phones after 12 h; an "out of commission" whose ticket has already been resolved never buzzes. With backfill never producing an event (invariant 4), a replayed day is silent.
- *Event wiring.* Trip start is a doorbell rung by the driver's START (never by a resume, never by buffered pings): T1 to the main favourite's holders, T3 with *Follow* / *Not today* to starred holders. Stop progress (`stop.reached`, arrived or skipped, never backfill) is T3 to riders following the trip whose stop is at or after it, collapsed on `trip-{id}-progress`. Signal lost is T2 to the trip's riders, T4 in a known dead zone, and T3 when it recovers.
- *Live frames.* The worker publishes `notification` / `ticket.update` frames on `pubsub:notify`; the gateway forwards them only to the named students' streams, without an id (invariant 9).
- *Measured.* 600 students, one T0: recorded and handed to a push stub answering in 20 ms in 0.31 s (PGlite) / 0.55 s (Postgres 15). Event → push received by a real browser through Google's push service: p50 590 ms, p95 2.4 s (n = 40, headless Chrome, local stack); a phone's own share is not measured yet (`vault/benchmarks/alert-latency-v1.md`).

### 6.4 The student's relationship to a bus

Four distinct concepts — keeping them separate is what makes the alert logic correct:

| Concept | Cardinality | Meaning | Alerts |
|---|---|---|---|
| **`main_favourite`** | exactly 1 | "My bus." The one I take daily. | Activation → **T1 URGENT**. Out of commission → **T0**. |
| **`starred`** | many | "Buses I might take." | Activation → **T3 INFO**, with inline *Follow* / *Not today* actions. |
| **`trip_subscription`** | 0–1 per day | "The bus I am actually taking today." Created by tapping *Follow*, or by choosing from the live map. | Per-stop progress (T3, collapsed) + **leave-now (T1)**. |
| **`muted`** | per bus, time-boxed | "Not today, thanks." Set by *Not today* — does **not** unstar. | Suppressed until end of day. |

This directly implements the requested flow: a student receiving an alert from a bus they are not taking taps *Not today*, which mutes that bus for the day **without** losing the star. Tomorrow it behaves normally again.

### 6.5 The kill switch

`profiles.alerts_paused_until timestamptz`.

- **"I'm on the bus"** → `now() + 3h`, capped at 23:59 local, and clears the day's `trip_subscription`.
- Auto-clears at the start of the next service window, so a student who pauses in the evening still gets morning alerts.
- **Per-bus mute** (`favourites.muted_until`) is the finer-grained tool; the global switch is the panic button.
- **Quiet hours** are stored as `(quiet_start_min, quiet_duration_min)` rather than a range, because the common case — 22:00 to 06:00 — wraps past midnight and cannot be expressed as one.
- T0 CRITICAL breaks through by default; a user can disable that in settings.

*Optional (Stage 8):* if the student's browser location is within 100 m of a bus and both are moving above 15 km/h, prompt "On Bus 14? Mute alerts for 3 hours." ⚠️ This only works while the tab is open — **web apps cannot track location in the background**, which is precisely why this is a prompt and not an automatic action.

---

## 7. Realtime channel design

One SSE connection per client: `GET /v1/stream`, JWT in the `Authorization` header. The web client is fetch-based rather than `EventSource`, because `EventSource` cannot send a header, and a token in the query string ends up in access logs. The client does what `EventSource` would have done, explicitly: it resends the last broadcast id as `Last-Event-ID`, reconnects with backoff and jitter (1 s to 30 s, at once on `online`), treats 2.5 heartbeats of silence as a dead connection, and fetches a fresh token per attempt. The gateway closes a stream when its token expires.

**Handshake.** Every stream opens with `stream.ready` (`{connId, heartbeatS, serverTime, replayTruncated?}`), then any Last-Event-ID replay, then a `fleet.snapshot` re-derived for this connection, then live frames. The client shows every age on the gateway's clock (`serverTime`), not the phone's. A snapshot is everything this connection wants, so the client replaces its fleet with it. A position older than one already held is ignored, and so is a status judged against an older fix, so replayed frames can never move a bus backwards or turn it amber again.

**Events:**

| Event | Payload | Cadence |
|---|---|---|
| `fleet.snapshot` | full state of relevant buses | on connect / resume |
| `bus.position` | delta: `{id, lat, lng, spd, hdg, s, ts}` | ≤ 1 Hz per bus |
| `bus.status` | `LIVE \| DEGRADED \| DARK \| ENDED` + reason + `cadence` | on transition |
| `eta.update` | `{tripId, stopId, p50, p90}` for the client's stop | on change > 30 s |
| `stop.reached` | `{tripId, stopId, seq, busId, event, at, backfill}`: `event` is arrived, departed or skipped; `backfill` marks crossings derived from late-flushed pings, which must never notify | on event |
| `notification` | notification-center entry | on send |
| `ticket.update` | ticket state transition | on change |
| `stream.ready` | `{connId, heartbeatS, serverTime}`: per-user, no id | on connect |
| `:heartbeat` | comment frame | every 15 s |

**Subscription scoping.** The client posts `{connId, bbox, busIds}` to `/v1/stream/focus`; the server sends only buses in view plus the client's favourites and active trip, answers with a fresh snapshot for the new focus, and also sends the one position frame that carries a bus out of view. The focus is stored as the value of the connection's own TTL key (below), so any gateway instance can accept the POST; the instance holding the stream picks it up on the next heartbeat. Because the key embeds the user id, another student's `connId` is simply not found (404). At 30 buses, broadcasting everything costs 30 × 60 B = 1.8 KB/s per client — which at **600 concurrent clients is ≈ 8.6 Mbit/s of egress, sustained, during the exact five minutes everyone is connected.** That is survivable but wasteful, and it is the number that grows fastest if real ridership turns out higher than assumed. Scoping drops it by ~80% to under 2 Mbit/s and is the pattern that survives both a 200-bus future and a concurrency estimate that was too low.

**Resumption.** Each broadcast frame carries an `id`. On reconnect the client sends `Last-Event-ID`, and the server replays from the Redis Stream — so a tunnel on the student's own commute does not lose their stop-arrival event. Replay is capped at 10,000 frames. If the stream has been trimmed past the client's id, `stream.ready` says `replayTruncated: true` and the snapshot is all there is. The check is conservative: it can flag a resume that lost nothing, never the reverse.

**Fan-out.** Each gateway process runs **one** blocking `XREAD` on `stream:events` and fans frames out to every stream it holds. Six hundred connections each blocking on Redis would be six hundred Redis connections.

⚠️ Only **broadcast-class** events (`bus.position`, `bus.status`, `stop.reached`) carry resumable ids from `stream:events`. Per-user frames (`eta.update`, `notification`) are not in a shared stream and are **re-derived on connect** from Redis and the notification center, not replayed. Mixing the two would let a resumed client receive another student's scoped payloads.

**Connection cap.** Three concurrent streams per user, tracked as **individual keys with a TTL** (`sse:conn:{userId}:{connId}`, 45 s, refreshed by the 15 s heartbeat), counted with a `SCAN` over the prefix — *not* as a plain SET. A SET with no expiry is a lockout waiting to happen: any gateway crash or `SIGKILL` leaves phantom connection ids behind, the user hits the cap against connections that no longer exist, and the only recovery is manual intervention in Redis. A key that dies when the heartbeat stops is self-healing.

A new stream claims its key **first and counts second**, so two racing connects can both be refused but never both admitted past the cap. Each key's value names the gateway instance holding it (`hostname:port`, stable across restarts), and a gateway **deletes its own leftover keys at boot**. After a `SIGKILL` and restart, a user is therefore never locked out at all. Keys held by an instance that does not come back expire within 45 s. A graceful shutdown ends every stream and deletes its key.

---

## 8. UI direction

The theme writes itself from the domain: **transit signage**. Think departure boards, not dashboards.

- **Dark-first.** Students use this at 7:30 a.m. and 5:30 p.m., often outdoors. Dark reduces glare and battery draw on OLED. A light theme ships too, respecting `prefers-color-scheme`.
- **Palette:** near-black canvas, one saturated accent for "live" (a signal green), amber for `DEGRADED`, red for `DARK` and T0. Colour carries *state*, never decoration — so colour-blind-safe pairings are checked, and every state also has a shape or text label.
- **Typography:** a geometric grotesque with excellent tabular numerals (Inter, or Geist). ETAs are numbers that update in place; non-tabular figures make them jitter.
- **Motion:** only to show causality. Markers ease along the route (§4). Stop progress fills a vertical route timeline. Nothing bounces, nothing spins decoratively.
- **The hero is the ETA, not the map.** The default student view is a large, unmissable "Bus 14 · 6 min · Dilsukhnagar" card, with the map *below* it. Most sessions last eleven seconds and answer exactly one question. The map is for when the number alone is not believed.
- **Honest degradation is visible design work,** not an error state bolted on. "Last seen 2m 14s ago" gets the same typographic care as a live ETA.

---

## 9. Environments and the production question

### Local (development and all testing)

Everything in `docker-compose.dev.yml`:

| Service | Image | Port |
|---|---|---|
| Supabase (Postgres 15 + PostGIS, Auth, Storage, Studio) | via Supabase CLI | 54321–54324 |
| Redis 7 | `redis:7-alpine` | 6379 |
| OSRM `car` | `ghcr.io/project-osrm/osrm-backend` + Hyderabad extract | 5000 |
| OSRM `foot` | `ghcr.io/project-osrm/osrm-backend` + Hyderabad extract | 5001 |
| Photon geocoder | `rtuszik/photon-docker` | 2322 |
| Tile server (ADR-0005) | `maptiler/tileserver-gl` + Hyderabad `.mbtiles` | 8080 |
| Mailpit (email capture) | `axllent/mailpit` | 8025 |

`pnpm dev` brings up the stack, applies migrations, seeds routes/stops/users, and starts the simulator. **One command, no cloud account, no internet required.**

### Production — the honest recommendation

> **Do not migrate off Supabase.**

Supabase Pro in `ap-south-1` (Mumbai) handles 600 concurrent users and ~19 M rows/year without breathing hard — and note that under ADR-0002 almost none of those users are reading from it on the live path anyway. Migrating a working Postgres to RDS buys nothing here except operational burden and a lost weekend. **Spend the available funding on the things that actually constrain this product — tracker hardware and an OSRM box — not on infrastructure you would only be replacing to feel serious.**

What you *add* for production, all in Mumbai to keep RTT under 30 ms:

| Component | Service | Est. cost |
|---|---|---|
| Postgres, Auth, Storage | **Supabase Pro**, `ap-south-1` | $25/mo |
| Gateway + Engine | **Fly.io** `bom` region, 2 × shared-1x-1GB | ~$10/mo |
| Redis | Fly Redis, or a Redis container beside the gateway | ~$5/mo |
| OSRM + Photon + **tile server** | **Hetzner CPX31** or DigitalOcean BLR, 4 vCPU / 8 GB | ~$16/mo |
| Map tiles | self-hosted on the box above, cached at Cloudflare (ADR-0005) | $0 |
| Web frontend | **Vercel** (`bom1`) or Cloudflare Pages | $0–20/mo |
| CDN / TLS / WAF | Cloudflare | $0 |
| SMS | MSG91, ~₹0.18 × ~4,000/mo | ~₹720/mo |
| **Total** | | **≈ $64/mo (~₹5,600) ⇒ ₹67,200/yr** |

### Reconciling this with the deck

⚠️ **This does not fit the deck's ₹37,700/yr recurring envelope, and the plan should say so rather than quietly disagree with its own cost model.**

The deck's ₹37,700 was M2M SIMs (₹22,500) + a single ₹1,200/mo VPS (₹14,400) + domain (₹800). That VPS line assumed one box running everything. The architecture above deliberately does not do that — separating ingestion from delivery, and the geo/tile box from the app box, is the decision the whole document rests on, and it costs about ₹53,000/yr more than one shared VPS.

| Scenario | Recurring |
|---|---|
| Deck as written (25 buses, single VPS) | ₹37,700/yr |
| **Pilot stage** (driver phones, no M2M SIMs) | **≈ ₹68,000/yr** |
| **Full fleet** (30 buses, + M2M SIMs at ₹27,000/yr) | **≈ ₹95,000/yr** |

Per student per year this moves from ₹18 to roughly **₹19–20** against the deck's 5,000-student denominator — which is to say, the honest number is still trivially defensible. **Present the higher figure.** A cost model that is quietly 2.5× optimistic is the kind of thing a funding committee finds on its own, and finding it costs more credibility than the ₹57,000 ever would have.

**If the envelope is genuinely hard,** the collapsible line items are Vercel (→ Cloudflare Pages, $0) and Supabase Pro (→ self-hosted Postgres on the Hetzner box, −$25/mo, at the price of running your own backups and Auth). That lands near ₹42,000/yr. Do this only if required; §9's whole argument is that operational burden is the expensive resource here, not rupees.

⚠️ **Upstash caveat:** attractive for serverless Redis, but BullMQ's blocking commands bill per request and behave awkwardly on it. Prefer a plain Redis instance co-located with the workers.

**The genuine migration triggers**, should they ever arrive: `positions` exceeding ~100 M rows (→ partition, or move to TimescaleDB), or multi-campus expansion (→ regional gateway sharding). Neither is on the horizon at 30 buses.

---

## 10. Security

- **RLS on every table**, denied by default. Students read only their own profile, subscriptions and notifications. Admin access is claim-based (`role` in the JWT), never a client-side check.
- **Tracker authentication:** each device holds a per-device secret. Every ingest request is HMAC-SHA256 signed over `(device_id, timestamp, body)`; the server rejects skew over 5 minutes and replayed nonces. The secret is **encrypted at rest and decryptable** (`pgcrypto`, key in the gateway's environment) — ⚠️ **it cannot be stored as a bcrypt hash**, because verifying an HMAC requires recomputing it with the same key, and a one-way hash makes that impossible. This is an easy and fatal mistake to make by analogy with password storage; the two cases are not alike. Secrets are rotatable from the admin console and are never returned to any client after issue.
- **Spoofing is a *likely* event with a phone-based tracker, not an exceptional one.** The driver PWA must hold its secret in IndexedDB on a phone a driver carries home, so treat extraction as expected rather than as a breach. The consequence is bounded — one bus — but one falsified bus is enough to send students to a stop for a vehicle that is not coming. The mitigations are the plausibility gates in §5.3 doing double duty: reject implausible jumps, reject sustained off-route positions, reject a trip start for a bus already reporting from elsewhere, and surface to the admin console any device whose ping stream begins without a corresponding driver shift assignment. Rate-limit per device so a stolen secret cannot flood the stream.
- **Rate limits:** ingest is capped per device (an unbounded loop must not flood the stream); auth endpoints are strictly limited; SSE is capped at 3 concurrent streams per user.
- **Driver location is fleet data, not personal tracking.** Positions attach to a *trip*, and driver identity is linked only for the duration of the assigned shift. Raw positions are retained 90 days, then aggregated into segment-speed statistics and deleted. Say this out loud to drivers before the pilot — it is both the right thing to do and the difference between cooperation and sabotage.
- **Student pinned locations** are stored coarsened (≈100 m precision is ample for a walking ETA) and are never exposed to admins or other students.
- **Every admin action** — announcements, CSV applies, out-of-commission flags — writes to `audit_log` with before/after state. A system that can buzz 300 phones needs a paper trail.
- **CSV upload is two-phase:** upload → parse → **diff preview** → explicit confirm → apply. No CSV ever auto-publishes.

---

## 11. Failure modes

| Failure | System response | What the student sees |
|---|---|---|
| Cellular dead zone | Tracker buffers locally, flushes on reconnect; backfill never re-triggers alerts | Amber at 3× cadence, "last seen 2m ago" — never a frozen live dot |
| Known dead zone | Classified against learned polygons | "In a known dead zone near Uppal — usually clears in ~90 s" |
| Tracker powers off | Presence sweeper → `ENDED` after 10 min | Bus leaves the live map rather than sitting stale |
| Postgres down | Redis serves live state; persister buffers in the stream | **Live map unaffected.** History unavailable. |
| Redis down | Gateway 503s ingest (trackers buffer and retry); last snapshot served from Postgres | Degraded, explicitly labelled "reconnecting" |
| Engine worker crash | Consumer group resumes from last ack; idempotency keys prevent replay damage | Brief ETA staleness |
| OSRM down | Falls back to historical segment speeds, then to straight-line ÷ 0.7 | Wider ETA range, confidence dot drops |
| Push service rejects | `410` prunes the subscription; T0/T1 fall back to SMS | Alert still arrives |
| Every student opens at 4 p.m. | Stateless gateway scales horizontally; ingest is a separate path | GPS collection completely unaffected |
| Bus goes off-route | 3 consecutive pings > 75 m off → `OFF_ROUTE`, ETAs suppressed | "Bus 14 is off its usual route" — no fabricated ETA |
| Bus reverses on-route (U-turn, missed turn) | 4 sustained backward pings → global re-snap, sequence reset | Brief ETA gap, then correct — not a silently frozen offset |
| Bus passes a stop without stopping | `skipped` event advances the sequence | Stop shown as passed; later stops keep notifying |
| Malformed CSV | Two-phase upload rejects at preview | Nothing. No notification is sent. |

**The governing rule:** *the app never fabricates a position or an ETA.* Every degraded state has a designed, honest, specific presentation. A stale timestamp shown plainly beats a confident wrong answer, every time.
