# Bus Mitra — Architecture

> Reference document for the technical design. Read this before writing code in any module.
> Companion documents: [SCHEMA.md](SCHEMA.md) (data model), [BUILD_PLAN.md](BUILD_PLAN.md) (staged delivery).

---

## 1. The shape of the problem

Before choosing anything, be honest about the numbers:

| Dimension | Value at full fleet | Implication |
|---|---|---|
| Buses reporting | 30 | — |
| Ping interval (moving) | 5 s | **6 writes/sec ingest** |
| Ping interval (idle) | 30 s | negligible |
| Concurrent students | 300 | 300 open streams |
| Live fleet state | 30 × ~120 bytes | **~4 KB — fits in L2 cache** |
| Positions/day | 30 × 4 h × 720/h | ~86 k rows/day, ~31 M/yr |
| Notifications/day | ~300 users × ~6 | ~1,800 sends/day |

**This is not a big-data problem.** Six writes per second is nothing. The entire live state of the fleet is four kilobytes. A single Node process could serve this a hundred times over.

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
| **Map** | MapLibre GL JS + MapTiler vector tiles | Free and open. Vector tiles let us restyle to the app theme instead of accepting Google's grey. GPU rendering makes 30 animated markers cost nothing. Mapbox GL went proprietary at v2; MapLibre is the fork that stayed open. |
| **Client state** | TanStack Query + Zustand | Query for REST/cached server state (stops, routes, notification history), Zustand for the live SSE-fed fleet store. Do not put streaming positions in Query — it is a cache, not a stream. |
| **API + realtime** | Fastify 5 on Node 22, native **SSE** | See ADR-0001 below. |
| **Hot state** | Redis 7 — Hashes, Streams, TTL keys | Sub-millisecond fleet state. Streams give durable, replayable ingest with consumer groups, so the persister can lag or crash without dropping pings. |
| **Background jobs** | BullMQ | Retries with backoff, rate limiting, repeatable jobs for the sweepers. Notification sends must never run inline on a request. |
| **Database** | Supabase Postgres 15 + PostGIS + pg_trgm + pgcrypto | Geospatial queries, fuzzy stop search, auth, storage and row-level security in one system. See §9 for the production migration answer (spoiler: don't migrate). |
| **ORM** | Drizzle | SQL-first, so raw PostGIS expressions stay readable. Generates types from the schema. Migrations are plain SQL files we can review. |
| **Routing / geo engine** | OSRM, self-hosted, Telangana OSM extract | `car` profile for bus travel times and route derivation, `foot` profile for student walk-to-stop ETAs. Free, runs locally, no per-request billing, works offline in dev. |
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

### 2.3 ADR-0002 — Redis as the live fleet, Postgres as the record

Redis holds authoritative *current* state; Postgres holds authoritative *historical* state. On gateway boot, Redis is rehydrated from the last 5 minutes of `positions` so a restart does not blank the map. Redis persistence is AOF `everysec` — losing one second of live positions on a hard crash is acceptable because the next ping is five seconds away.

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

---

## 5. Core algorithms

These live in `packages/geo` as pure, deterministic, heavily-tested functions. No I/O, no clock reads — every one takes its inputs explicitly so it can be replayed against recorded traces.

### 5.1 Route representation

A route is a polyline of `N` vertices with a precomputed array of cumulative distances `D[0..N-1]`, `D[0] = 0`. Built once at route-publish time, cached in Redis and in worker process memory. Every position on the route is then a single scalar: **route offset `s`**, in metres from the origin.

Reducing a 2-D tracking problem to a 1-D scalar is what makes everything downstream cheap and robust.

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
if s_new < s_prev - BACKWARD_TOLERANCE (30 m):  reject, keep s_prev
if s_new - s_prev > maxPlausibleJump(dt):       reject as a GPS spike
else:                                           accept
```

Without this, a stop can "arrive" twice as the offset jitters across its boundary. This is the root cause of duplicate-notification bugs in most naive implementations.

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
```

Sequence state lives in `trip:{id}:seq` and only ever increases. Every emitted event writes to `trip_stop_events` with a `UNIQUE (trip_id, stop_id, event)` constraint — so the database is the final idempotency backstop even if a worker is replayed.

### 5.5 ETA

Three inputs, blended, degrading gracefully as history accumulates:

```
For each segment between current offset s and target stop offset D_k:

  v_hist  = rolling median speed for (route, segmentBucket, weekday, timeOfDayBucket)
  v_live  = EWMA of recent observed speed, α = 0.3
  v_osrm  = OSRM's free-flow expected speed for that geometry

  v_expected = 0.55·v_hist + 0.35·v_live + 0.10·v_osrm     (history exists)
             = 0.60·v_osrm·congestionFactor + 0.40·v_live  (cold start, < 10 trips)

  where congestionFactor = clamp(v_live / v_osrm_here, 0.3, 1.2)
  clamp v_expected to [5, 60] km/h

ETA_k = Σ (segmentLength / v_expected) + Σ expectedDwell(intermediate stops)
```

`expectedDwell` is the historical median of `departed − arrived` per stop, defaulting to 30 s.

**Report a range, not a point.** Segment speed variance gives a p90. The UI shows "4–6 min" with a confidence dot. A single confident number that is wrong destroys trust faster than an honest range ever will.

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

### 5.7 Dead-zone detection and learning

This is an explicit product requirement and deserves more than a timeout.

**Presence state machine**, driven by a 5 s sweeper over `fleet:live`:

| State | Condition | Map | Notification |
|---|---|---|---|
| `LIVE` | age < 25 s | solid marker | — |
| `DEGRADED` | 25 s ≤ age < 75 s | amber, "last seen 34 s ago" | none — avoid alarm fatigue |
| `DARK` | age ≥ 75 s | red, frozen at last known, explicit timestamp | see classification below |
| `ENDED` | explicit trip end, or DARK > 10 min | **removed from map** | trip closed |

⚠️ Do not rely on Redis key-expiry notifications for this — they are lazy and best-effort. Run an explicit sweeper.

**Classification on entering DARK** — the part that makes this intelligent:

```
if lastKnownPosition ∈ a known dead_zones polygon:
    → "Bus 14 is in a known dead zone near Uppal flyover.
       Usually clears in about 90 seconds."
    → tier INFO, in-app only, NO push
else:
    → "Signal lost from Bus 14 near <nearest landmark>."
    → tier WARNING, push to today's riders of that trip + admin console
    → open an automatic ticket if it persists past 5 minutes
```

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

**The `tag` detail matters enormously.** A 12-stop route would otherwise produce 12 stacked notifications. All T3 stop-progress notifications for one trip share `tag: "trip:{id}:progress"` with `renotify: false`, so each *replaces* the last. The student sees one notification that keeps updating: "Bus 14 — now at Dilsukhnagar, 3 stops away." T0 sets `requireInteraction: true`.

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
3. Tier below the user's minimum preference → suppress
4. Quiet hours → defer non-T0 to the next window

**Channel selection:**

```
for each recipient:
  if has a healthy push subscription                        → web push
  if tier ≤ T1 and (no push sub OR push failed within 20 s) → SMS
  always                                                    → write to notification center
```

Note that **the notification center is written unconditionally**, regardless of push success. The in-app history is the source of truth; push and SMS are best-effort transports on top of it.

**Push subscription health:** a `410 Gone` or `404` from the push service permanently deletes the subscription. Repeated `429`s back off per endpoint. `failure_count ≥ 5` marks it unhealthy and promotes SMS eligibility.

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
- T0 CRITICAL breaks through by default; a user can disable that in settings.

*Optional (Stage 8):* if the student's browser location is within 100 m of a bus and both are moving above 15 km/h, prompt "On Bus 14? Mute alerts for 3 hours." ⚠️ This only works while the tab is open — **web apps cannot track location in the background**, which is precisely why this is a prompt and not an automatic action.

---

## 7. Realtime channel design

One SSE connection per client: `GET /v1/stream` (JWT via a fetch-based EventSource polyfill, or a short-lived signed query token).

**Events:**

| Event | Payload | Cadence |
|---|---|---|
| `fleet.snapshot` | full state of relevant buses | on connect / resume |
| `bus.position` | delta: `{id, lat, lng, spd, hdg, s, ts}` | ≤ 1 Hz per bus |
| `bus.status` | `LIVE \| DEGRADED \| DARK \| ENDED` + reason | on transition |
| `eta.update` | `{tripId, stopId, p50, p90}` for the client's stop | on change > 30 s |
| `stop.reached` | `{tripId, stopId, seq}` | on event |
| `notification` | notification-center entry | on send |
| `ticket.update` | ticket state transition | on change |
| `:heartbeat` | comment frame | every 15 s |

**Subscription scoping.** The client posts `{bbox, busIds}` to `/v1/stream/focus`; the server sends only buses in view plus the client's favourites and active trip. At 30 buses we could broadcast everything (30 × 60 B = 1.8 KB/s per client; 300 clients ≈ 4 Mbit/s), but scoping drops that by ~80% and is the pattern that survives a 200-bus future.

**Resumption.** Each frame carries an `id`. On reconnect the browser sends `Last-Event-ID` automatically, and the server replays from the Redis Stream — so a tunnel on the student's own commute does not lose their stop-arrival event.

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
| OSRM `car` | `osrm/osrm-backend` + Telangana extract | 5000 |
| OSRM `foot` | `osrm/osrm-backend` + Telangana extract | 5001 |
| Photon geocoder | `rtuszik/photon-docker` | 2322 |
| Mailpit (email capture) | `axllent/mailpit` | 8025 |

`pnpm dev` brings up the stack, applies migrations, seeds routes/stops/users, and starts the simulator. **One command, no cloud account, no internet required.**

### Production — the honest recommendation

> **Do not migrate off Supabase.**

Supabase Pro in `ap-south-1` (Mumbai) handles 300 concurrent users and 31 M rows/year without breathing hard. Migrating a working Postgres to RDS buys nothing here except operational burden and a lost weekend. **Spend the available funding on the things that actually constrain this product — tracker hardware and an OSRM box — not on infrastructure you would only be replacing to feel serious.**

What you *add* for production, all in Mumbai to keep RTT under 30 ms:

| Component | Service | Est. cost |
|---|---|---|
| Postgres, Auth, Storage | **Supabase Pro**, `ap-south-1` | $25/mo |
| Gateway + Engine | **Fly.io** `bom` region, 2 × shared-1x-1GB | ~$10/mo |
| Redis | Fly Redis, or a Redis container beside the gateway | ~$5/mo |
| OSRM + Photon | **Hetzner CPX31** or DigitalOcean BLR, 4 vCPU / 8 GB | ~$16/mo |
| Web frontend | **Vercel** (`bom1`) or Cloudflare Pages | $0–20/mo |
| CDN / TLS / WAF | Cloudflare | $0 |
| SMS | MSG91, ~₹0.18 × ~2,000/mo | ~₹360/mo |
| **Total** | | **≈ $60/mo (~₹5,200)** |

Comfortably inside the deck's ₹37,700/yr recurring envelope, with room for the M2M SIMs once hardware trackers land.

⚠️ **Upstash caveat:** attractive for serverless Redis, but BullMQ's blocking commands bill per request and behave awkwardly on it. Prefer a plain Redis instance co-located with the workers.

**The genuine migration triggers**, should they ever arrive: `positions` exceeding ~100 M rows (→ partition, or move to TimescaleDB), or multi-campus expansion (→ regional gateway sharding). Neither is on the horizon at 30 buses.

---

## 10. Security

- **RLS on every table**, denied by default. Students read only their own profile, subscriptions and notifications. Admin access is claim-based (`role` in the JWT), never a client-side check.
- **Tracker authentication:** each device holds a per-device secret. Every ingest request is HMAC-SHA256 signed over `(device_id, timestamp, body)`; the server rejects skew over 5 minutes and replayed nonces. A leaked token lets an attacker spoof exactly one bus, and it can be rotated from the admin console.
- **Rate limits:** ingest is capped per device (an unbounded loop must not flood the stream); auth endpoints are strictly limited; SSE is capped at 3 concurrent streams per user.
- **Driver location is fleet data, not personal tracking.** Positions attach to a *trip*, and driver identity is linked only for the duration of the assigned shift. Raw positions are retained 90 days, then aggregated into segment-speed statistics and deleted. Say this out loud to drivers before the pilot — it is both the right thing to do and the difference between cooperation and sabotage.
- **Student pinned locations** are stored coarsened (≈100 m precision is ample for a walking ETA) and are never exposed to admins or other students.
- **Every admin action** — announcements, CSV applies, out-of-commission flags — writes to `audit_log` with before/after state. A system that can buzz 300 phones needs a paper trail.
- **CSV upload is two-phase:** upload → parse → **diff preview** → explicit confirm → apply. No CSV ever auto-publishes.

---

## 11. Failure modes

| Failure | System response | What the student sees |
|---|---|---|
| Cellular dead zone | Tracker buffers locally, flushes on reconnect; backfill never re-triggers alerts | Amber marker, "last seen 2m ago" — never a frozen live dot |
| Known dead zone | Classified against learned polygons | "In a known dead zone near Uppal — usually clears in ~90 s" |
| Tracker powers off | Presence sweeper → `ENDED` after 10 min | Bus leaves the live map rather than sitting stale |
| Postgres down | Redis serves live state; persister buffers in the stream | **Live map unaffected.** History unavailable. |
| Redis down | Gateway 503s ingest (trackers buffer and retry); last snapshot served from Postgres | Degraded, explicitly labelled "reconnecting" |
| Engine worker crash | Consumer group resumes from last ack; idempotency keys prevent replay damage | Brief ETA staleness |
| OSRM down | Falls back to historical segment speeds, then to straight-line ÷ 0.7 | Wider ETA range, confidence dot drops |
| Push service rejects | `410` prunes the subscription; T0/T1 fall back to SMS | Alert still arrives |
| Every student opens at 4 p.m. | Stateless gateway scales horizontally; ingest is a separate path | GPS collection completely unaffected |
| Bus goes off-route | 3 consecutive pings > 75 m off → `OFF_ROUTE`, ETAs suppressed | "Bus 14 is off its usual route" — no fabricated ETA |
| Malformed CSV | Two-phase upload rejects at preview | Nothing. No notification is sent. |

**The governing rule:** *the app never fabricates a position or an ETA.* Every degraded state has a designed, honest, specific presentation. A stale timestamp shown plainly beats a confident wrong answer, every time.
