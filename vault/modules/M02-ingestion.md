---
stage: M02
title: Ingestion pipeline
status: in-progress
started: 2026-09-22
completed: —
---

# M02 — Ingestion pipeline

## Summary

A phone on a dashboard now reaches the database. The driver PWA samples GPS at the shared
cadence rule, writes every fix to an IndexedDB ring buffer *before* the network is tried, and
posts HMAC-signed batches every five seconds; the gateway verifies the signature, checks the
trip belongs to that bus, marks late fixes as backfill and `XADD`s to `stream:pings` without
touching Postgres; two independent consumer groups then turn those pings into live fleet state
(Redis) and durable history (`positions`, via `COPY` into a staging table).

**Status is in-progress, not complete.** Everything is built and tested, and a 30-bus hour-long
run and a real-browser airplane-mode trip both verified end to end. The one exit criterion left
needs hardware: the airplane test on an actual phone, on a real cellular network.

## Scope delivered

- [x] Driver tracker: `watchPosition({enableHighAccuracy})`, 5 s moving / 15 s stationary, with
      `cadence_s` in every batch (the rule itself lives in `@busmitra/contracts/tracker`, so the
      simulator and the app cannot drift apart)
- [x] Wake Lock, **re-acquired on every `visibilitychange` → visible**, with an honest chip when
      the browser refuses it
- [x] IndexedDB ring buffer (20,000 pings ≈ a day), written before any network attempt
- [x] Batch POST every 5 s; reconnect flush in ≤500-ping requests with original `recorded_at`
- [x] Exponential backoff with full jitter; `navigator.onLine` **plus** a `/healthz` probe before
      the next real attempt after a transport failure
- [x] Trip UI: route picker → START TRIP → "N sent · M waiting to send" → END TRIP
- [x] `POST /v1/ingest`: HMAC over `(device_uid, timestamp, raw body)`, ±5 min skew, Redis nonce
- [x] Zod validation; per-device rate limit (120 req/min) in Redis
- [x] `is_backfill` when `ingested_at − recorded_at > 30 s`
- [x] HMAC against the **decrypted** `secret_enc`, with `secret_prev_enc` accepted for a 10-minute
      rotation overlap
- [x] `XADD stream:pings` then respond — **no database write on that path**
- [x] `packages/redis` key registry (+ a repo scan that fails the build if a key is built inline)
- [x] `engine/geo.ts`: snap → monotonic progress → EWMA → `fleet:live` (backfill never overwrites
      a newer entry; an ended trip is never resurrected)
- [x] `engine/persister.ts`: 200 rows / 2 s → `COPY` into a transaction-scoped staging table →
      `INSERT … ON CONFLICT DO NOTHING`
- [x] `positions` weekly partitions + `pg_cron`
- [ ] **Not done:** the airplane-mode test on a physical phone on a cellular network. Verified in
      a desktop browser with the network cut at the protocol level, and in the simulator.

**Deliberately not done, and why:**

- *Serving positions to students.* Nothing reads `fleet:live` outwards yet — SSE, the map and
  presence states are Stage 3. The data is there and correct; nobody can see it.
- *BullMQ.* The two consumers are Redis Stream consumer groups, which is what durability and
  replay need. BullMQ arrives with the scheduled jobs that actually want retries and repeats.
- *Rehydrating Redis from `positions` on boot* (ADR-0002). It matters when a restart would blank
  a live map; there is no live map yet. Carried to Stage 3.
- *Dropping expired partitions.* The function exists, unscheduled: SCHEMA §12 says rows are
  aggregated into `segment_speeds` before they are dropped, and that job is Stage 5.

## Components added

| Path | What it is |
|---|---|
| `packages/redis/**` | the key registry (SCHEMA §10), `fleet:live` compare-and-set in Lua, stream helpers (append, group read, claim, ack), a namespaced test harness |
| `packages/contracts/src/tracker.ts` | the cadence rule: `nextCadence`, `pingDue`, `CADENCE` |
| `packages/contracts/src/signing.ts` | `signingPayload` + header names, dependency-free so Zod never ships to the phone |
| `packages/contracts/src/ingest.ts` | `StreamPing`, `StreamTripEnd`, `IngestResult`, `TrackerMe`, `TripStart(ed)` |
| `packages/db/migrations/0004_ingestion.sql` | `trips`, partitioned `positions` + maintenance functions, `trip_stop_events`, RLS |
| `apps/gateway/src/plugins/device-auth.ts` | raw-body capture, skew, HMAC against every live secret, replay cache |
| `apps/gateway/src/routes/ingest/index.ts` | `POST /v1/ingest` |
| `apps/gateway/src/routes/tracker/index.ts` | `/v1/tracker/me`, trip start/end, `POST /v1/survey` |
| `apps/gateway/src/services/{trackers,trips}.ts` | device and trip directories (cached, stale-on-error) and the trip lifecycle |
| `apps/gateway/src/cli/tracker.ts` | `pnpm tracker provision|rotate` — pairing links until Stage 7's UI |
| `apps/engine/src/workers/geo.ts` | the `geo` consumer: `stepTrip` → Redis |
| `apps/engine/src/workers/persister.ts` | the `persist` consumer: batched `COPY` → `positions` |
| `apps/engine/src/lib/route-cache.ts` | route geometry: memory → Redis → Postgres |
| `apps/engine/src/main.ts` | the engine process |
| `apps/driver/**` | the driver PWA: pairing, trip session, sampler, buffer, uplink, wake lock, survey mode, offline shell |

## Schema changes

| Migration | Change | Reversible? |
|---|---|---|
| `0004_ingestion.sql` | `trips` (+ `one_live_trip`), `positions` partitioned by week with `ensure_positions_partitions()` / `drop_expired_positions_partitions()` and a daily `pg_cron` job, `trip_stop_events`, audit trigger on `trips`, RLS + grants | yes, with data loss: `SELECT cron.unschedule('ensure-positions-partitions'); DROP TABLE trip_stop_events, positions CASCADE; DROP TABLE trips CASCADE; DROP FUNCTION ensure_positions_partitions(int,int), drop_expired_positions_partitions(interval);` |

`SCHEMA.md` §4, §9, §10 and §12 were updated in the same change (partition maintenance, the
temp staging table, the new Redis keys, the RLS rows).

## Configuration

| Variable | Purpose | Where to obtain | Secret? |
|---|---|---|---|
| `REDIS_URL` | already documented; now required by the gateway and the engine | compose | no |
| `TRACKER_SECRET_KEY` | already documented; now actually used — `pgp_sym_decrypt` of `trackers.secret_enc` | `openssl rand -hex 32` | **yes** |
| `VITE_GATEWAY_URL` | the gateway the driver app talks to. **Must be reachable from the phone**: on a LAN test, the laptop's IP, not `localhost` | deployment | no |
| `DRIVER_ORIGIN` | the driver PWA's origin, for CORS and pairing links | deployment | no |

## Technical decisions

- **The tracker's retry contract is the response code.** 200 means every ping is either queued
  or listed in `rejected` (never resend those); 400 means the batch can never succeed (drop it,
  do not block the queue behind it); 401 means keep the pings and tell the driver *why* (clock
  or pairing); 409 `replay` means the gateway already has exactly this request (treat as
  delivered); 409 `trip_not_live` means stop; 429/5xx/offline means keep everything and back off.
  Every one of those branches is tested, because a tracker that misreads one either loses a
  trip's data or hammers a struggling gateway.
- **Replay protection applies to writes only.** A GET changes nothing and callers legitimately
  repeat one; rejecting a repeated GET turned into "this phone is not assigned to a bus" in the
  driver app (see Gotchas).
- **Ingest never reads Postgres synchronously.** Device identity and trip validity come from
  in-process caches with **stale-on-error**: if Postgres is unreachable, ingest keeps flowing on
  the last known answer (ARCH §11). The accepted cost is that a rotated or revoked secret keeps
  verifying for up to 60 s.
- **One geo consumer.** A consumer group spreads entries across consumers, so two geo workers
  would interleave on the same trip's state. `fleet:live` is safe regardless (compare-and-set in
  Lua), but the per-trip state would not be. Sharding by bus is the scale-out path; at 6 pings/s
  it is nowhere near needed, and the file says so where someone would otherwise "helpfully"
  scale it.
- **Per-trip geo state lives in Redis, not worker memory.** A restarted worker resumes mid-trip
  rather than re-snapping from scratch and re-emitting stop events.
- **The persister snaps independently of the geo worker.** `positions.route_offset_m` is history;
  making the persister wait on the geo worker (or vice versa) would couple the two paths the
  architecture deliberately separates. It keeps its own window hint per trip, bounded.
- **END waits for the buffer.** If the driver ends a trip inside a dead zone, the END request is
  queued behind the buffered pings, so the server never closes a trip and *then* receives its
  last ten minutes.

## Gotchas and failure modes

- **Symptom:** the driver app said "This phone is not assigned to a bus yet" for a phone that
  was paired seconds earlier; the same request by hand returned the bus.
  **Cause:** React StrictMode runs effects twice in development, so two *identical* signed GETs
  went out. The second hit the replay cache and returned `409 {error:"replay"}` — and the app
  used the body as if it were data.
  **Fix:** the nonce now guards writes only, and the app treats any non-200 as an error.
  **Prevention:** both halves are the lesson — replay protection belongs on state changes, and a
  client must never render an error body as a payload.

- **Symptom:** a late buffer flush put an ended bus back on the map as LIVE.
  **Cause:** those pings are genuinely newer than the last fix the worker saw, so the
  compare-and-set on `ts` accepted them and overwrote `state: "ENDED"`.
  **Fix:** the Lua script refuses a write that would resurrect the same trip after ENDED.
  **Prevention:** `redis.test.ts` covers it, including that the bus's *next* trip writes normally.

- **Symptom:** the whole simulator process died ten seconds into an hour-long run with
  `ECONNREFUSED`.
  **Cause:** the gateway restarted (file watch), and trip start — unlike batch sending — had no
  retry. The rejection was unhandled.
  **Fix:** `callWithRetry` for trip start/end, and one bus's failure is recorded rather than
  fatal to the run.
  **Prevention:** the same lesson applies to the phone: a tracker must survive a gateway
  restart, because deploys happen during service hours.

- **Symptom:** while offline, the driver app spun at 100% CPU.
  **Cause:** `onStats → maybeFinishEnding → tick → onStats`: the uplink called back into itself
  through its own stats callback, and every pass returned early without changing anything.
  **Fix:** stats only re-render; draining is driven by the 5 s timers.

- **Symptom:** OSRM calls failed intermittently with `UND_ERR_SOCKET` ("other side closed"),
  only when a suite had been idle for a while.
  **Cause:** OSRM closes idle keep-alive connections; Node's pool finds out by trying.
  **Fix:** one retry for idempotent GETs in the OSRM client (no response was read, so a retry
  cannot duplicate anything).
  **Prevention:** four consecutive clean suite runs; the comment says why retrying is safe here
  and would not be on a POST.

- **Symptom:** two edits to the same file silently did nothing, and the tests "passed".
  **Cause:** patching by exact string match after Prettier had reformatted the target.
  **Fix:** verify the file after an automated edit — `grep` for the new text, not just a green
  test run.
  **Prevention:** written down because it cost two misleading test cycles.

- **Symptom:** the ingest response reported `accepted` larger than the number of rows that
  appeared.
  **Cause:** none — by design. Duplicate batches (a tracker retrying after a lost ack) are
  accepted again at the gateway and collapse at the unique index. The run's verifier counts
  *distinct* fixes, not acknowledgements.

- **Watch for:** `COPY` has no `ON CONFLICT`. The staging table is not an optimisation, it is
  what stops one duplicate row from aborting a 200-row batch — and a tracker retrying after a
  timeout is an everyday event.

- **Watch for:** the persister's snapping uses a forward-biased window per trip. A backfilled
  fix that arrives after later ones can snap with a hint from further along the route; it still
  falls back to a global search when that fails, but historical offsets on a loop route are the
  place where a wrong pass could hide. The live path is unaffected (it ignores stale fixes).

## Verifying locally

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm format:check
pnpm test                       # 310 tests / 40 files
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  pnpm vitest run packages/db apps/engine apps/gateway    # 130 of them on Supabase Postgres 15

# with the stack up (pnpm dev, which now also starts the engine and the driver app):
pnpm sim seed
pnpm sim run --buses 30 --minutes 60          # the exit criterion, with its own verdict
pnpm sim run --buses 3 --minutes 6 --airplane 2:1:3   # a short airplane-mode run

# a real browser as the driver:
pnpm tracker provision --bus 14               # prints a pairing link once
pnpm --filter @busmitra/driver dev            # open the link, pick a route, START TRIP
```

`sim run` prints a JSON verdict and exits non-zero if anything was dropped, duplicated,
mis-flagged, or if any bus's live entry ever moved backwards in time.

## Performance

The Stage 2 exit run, 2026-09-23 — full detail in
[`benchmarks/ingest-1h-30-buses-v1.md`](../benchmarks/ingest-1h-30-buses-v1.md):

| Metric | Target | Measured | Conditions |
|---|---|---|---|
| Distinct fixes sent → rows in `positions` | equal | **19,696 → 19,696** | 30 buses, 63 min, one laptop running the whole stack |
| Dropped / duplicated / unexpected rows | 0 | **0 / 0 / 0** | with 384 duplicate batches and 2% reordering injected |
| `is_backfill` correct | exact | **7,771 / 7,771**, 0 false positives | dead zones per route + one 3-minute airplane window |
| `fleet:live` regressions | 0 | **0** | 64,260 samples, 1 Hz over all 30 buses |
| Batches that never got through | 0 | **0** | 349 retries absorbed, including two gateway restarts mid-run |
| Sustained ingest rate | ~6 writes/s at full fleet | **~5.2 pings/s** end to end | ~19.7 k fixes in 63 min |
| Persister drain after the last batch | — | **< 3 min** to `pending = 0, lag = 0` | 200-row batches |

The airplane-mode criterion was also run against the **real driver app** in a browser, with the
network cut at the protocol level mid-trip:

| Phase | App showed | In `positions` |
|---|---|---|
| 40 s online | 9 sent, 0 waiting | 9 rows, lag ≈ 3 s, `is_backfill = false` |
| 75 s offline | 9 sent, **15 waiting**, "No network — buffering" | nothing new |
| 25 s after reconnect | **29 sent, 0 waiting** | all 29 rows, timestamps and order intact |
| END TRIP | back to the route picker | trip `completed` |

Of those 29 rows, exactly the 10 with a lag over 30 s were flagged `is_backfill` (lag 75 s down
to 35 s); the ones at 25 s and below were not. Offsets increased monotonically, 3 m → 8,320 m.

Other measurements:

| Metric | Measured |
|---|---|
| Driver bundle | 254 kB, **77 kB gzipped** (≈ 60 kB of it React) |
| Test suite | 310 tests / 40 files in ~28 s; 130 of them also on Supabase Postgres 15 |

## Rolling back

Code: remove `packages/redis`, `apps/driver`, `apps/engine/src/workers/{geo,persister}.ts`,
`apps/engine/src/main.ts`, `apps/gateway/src/{plugins/device-auth.ts,routes/ingest,routes/tracker,services/trackers.ts,services/trips.ts,cli}`.
Database: the `0004` rollback above. `positions` is partitioned — dropping it drops every
partition with it, which is every position ever recorded. Export first.
Redis: `DEL fleet:live`, `DEL stream:pings`, and the `bus:*`/`trip:*` keys expire on their own.

## Carried forward

- **Exit, needs hardware:** the airplane-mode test on a physical phone on a cellular network
  (verified in a desktop browser with the network cut, and in the simulator).
- **Stage 3:** rehydrate `fleet:live` from the last five minutes of `positions` on engine boot
  (ADR-0002), so a restart does not blank the map.
- **Stage 3:** the presence sweeper, and writing `trip_stop_events` from the crossing events the
  geo worker already computes.
- **Stage 3:** `stream:pings:dead` needs somewhere to be seen. It is a human queue with nothing
  watching it; the admin observability page (Stage 8) or an alert should surface a non-zero length.
- **Stage 5:** schedule `drop_expired_positions_partitions` once the nightly `segment_speeds`
  aggregation exists, and add the student RLS policy on `positions` with `trip_subscriptions`.
- **Stage 6:** the driver app is English-only. Drivers may read Telugu or Hindi; the strings are
  few and worth translating before the pilot.
- **Stage 9:** the driver bundle is 254 kB (77 kB gzipped), almost all React. `preact/compat` is
  the lever if first load on a weak connection proves painful.
