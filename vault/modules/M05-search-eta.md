---
stage: M05
title: Stops, search and personal ETA
status: in-progress
started: 2026-09-23
completed: —
---

# M05 — Stops, search and personal ETA

## Summary

The app now answers the question it exists for. A student types a stop the way it sounds —
"dilsuknagar", "kothi" — or a locality, and sees every stop within 2 km with the buses that serve
it, each as *running · 4–6 min*, *scheduled · 07:40*, *already passed* or *not running today*.
They pin their home (stored at ~100 m), open a stop, and take a bus. The home screen then leads
with "Bus 14 · 34–45 min · Koti", when to leave, and the route timeline. Behind it the engine
recomputes an ETA range to every stop ahead on every position, and a 10-second evaluator emits a
single `leave_now` event per student when it is time to go. Delivering that event is Stage 6.

**Status is in-progress, and will stay so until real buses have run.** Every build item is done
and the two deterministic exits pass. Three exits need the world: a stopwatch-timed walk, and
the ETA soak (≥10 real trips, MAE < 90 s at a 10-minute horizon). The soak **blocks Stage 6**.
The same measurement over simulated trips is recorded as a pipeline baseline (146 s), and it is
explicitly *not* the gate. See **Performance**.

## Scope delivered

- [x] Stop search: pg_trgm over name, aliases and area, **plus a phonetic fold for Indian place
      names** → Photon when the best match < 0.4 → every stop within 2 km of the best stop or the
      geocoded place → ranked; matching cached 5 min in Redis, buses joined fresh
- [x] Result rendering: running (live ETA range, or why not) / passed / scheduled / not running
      today
- [x] Location pinning: drag the pin or "use my location"; coarsened to ~100 m **by the
      database**; travel mode (already in settings)
- [x] Walking ETA via OSRM foot (bicycle at 15 km/h over the foot route; car/motorbike via OSRM
      car) → `walk_eta_cache`, refreshed after 24 h, emptied by the database on pin or mode change
- [x] `engine/eta.ts`: the §5.5 blend with the four-rung ladder → `trip:{id}:eta`; `eta.update`
      on > 30 s change, over pub/sub, to the connections watching that stop; withdrawn when DARK,
      ENDED, off-route, re-snapped, or passed
- [x] Leave-now evaluator: 10 s over `subs_active`, LIVE-and-fresh only, database compare-and-set,
      **emits `leave_now` to `stream:notify` only**
- [x] Trip subscription lifecycle (one bus a day; active → completed / missed) + vertical route
      timeline on the home hero card
- [x] Nightly `segment_speeds` (incremental, four rungs, idempotent per day, 14-day catch-up) on
      `pg_cron`; `drop_expired_positions_partitions` now scheduled after it
- [x] Predicted-vs-actual instrumentation per stop (`eta_predictions`), and `pnpm sim eta-report`
- [x] Carried forward and done: the student RLS policy on `positions`

**Deliberately not done, and why:**

- **Favourites** (main / starred / muted, SCHEMA §5) are the alert relationships of Stage 6 and
  land there with their RLS cases.
- **Scheduled trips have no source yet.** Search renders `scheduled · 07:40` for any trip row with
  `status = 'scheduled'` and a `scheduled_start_at`, and tests prove it. Nothing creates such rows
  until the Stage 7 fleet console / event-day CSV. Until then a bus that has not started shows as
  "not running today" if it has a default route.
- **Tuning the blend weights.** The plan says to tune on the real soak; tuning to the simulator's
  invented traffic would fit fiction.

## Components added

| Path | What it is |
|---|---|
| `packages/db/migrations/0006_search_eta.sql` | `segment_speeds` (+ runs ledger, aggregation, catch-up), `trip_subscriptions`, `walk_eta_cache`, `eta_predictions`, `fold_place`, pin triggers, RLS, `pg_cron` |
| `packages/contracts/src/search.ts` | search, stop detail, pin, subscription, `LeaveNowEvent` |
| `apps/gateway/src/services/search.ts` | the search algorithm (matching + per-stop buses) |
| `apps/gateway/src/services/geocoder.ts` | Photon, clipped to the Hyderabad bbox |
| `apps/gateway/src/routes/api/{search,me}.ts` | `/v1/search/stops`, `/v1/stops/:id`, `/v1/me`, `/v1/me/home`, `/v1/me/subscription` |
| `apps/engine/src/workers/eta.ts` | per-stop ETA engine, announcements, prediction log |
| `apps/engine/src/workers/leave-now.ts` | the leave-now evaluator |
| `apps/engine/src/lib/speed-model.ts` | IST buckets, the history ladder cache, OSRM segment speeds |
| `apps/engine/src/walk.ts` | home → stop travel time by mode, cached |
| `apps/simulator/src/eta-report.ts` | `pnpm sim eta-report`: MAE per horizon from `eta_predictions` |
| `apps/web/app/(student)/{search,stop/[id]}` | search and stop pages |
| `apps/web/components/{eta,search,settings}` | hero card, timeline, ETA range, bus line, home-pin editor |
| `tests/e2e/stage5.ts` | the student path in a real browser |

## Files changed

| Status | Path | What changed and why |
|---|---|---|
| added | `packages/db/migrations/0006_search_eta.sql`, `packages/db/src/search-eta.test.ts` | schema + 12 tests (ladder, idempotency, catch-up, pin coarsening, cache invalidation, RLS) |
| added | `packages/contracts/src/search.ts`; modified `index.ts`, `sse.ts` | contracts; `eta.update.withdrawn`, `StreamFocus.stopIds` |
| modified | `packages/redis/src/keys.ts` | `route:{id}:osrm`, `stream:notify`, `pubsub:eta`, `eta` group |
| added | `apps/engine/src/workers/{eta,leave-now}.ts`, `eta.test.ts`, `lib/speed-model.ts`, `walk.ts` | engine |
| modified | `apps/engine/src/{osrm,routes}.ts`, `lib/route-cache.ts` | OSRM route legs; stop dwell carried with the route |
| modified | `apps/engine/src/workers/stop-events.ts` | fills `eta_predictions.actual_arrival_at` |
| modified | `apps/engine/src/main.ts`, `package.json` | ETA worker (+ optional `OSRM_CAR_URL`) and leave-now ticker |
| added | `apps/gateway/src/services/{search,geocoder}.ts`, `routes/api/{search,me}.ts` (+ tests) | gateway |
| modified | `apps/gateway/src/routes/stream/index.ts` (+ test) | per-user `eta.update`: re-derived on connect/focus, live over pub/sub |
| modified | `apps/gateway/src/{app,server,testing}.ts` | Stage 5 routes; `OSRM_FOOT_URL`, `PHOTON_URL` now required by the gateway |
| added | `apps/simulator/src/eta-report.ts`; modified `cli.ts` | accuracy report |
| added | web pages and components listed above; `components/live/{live-provider,use-network}.ts` | one stream per session, focus merged across pages |
| modified | `apps/web/lib/store/{fleet,fleet-reducer}.ts` (+ test), `app/(student)/{layout,page,settings/page}.tsx`, `components/live/*` | ETAs in the store; hero on home; Search in nav; pin editor |
| added | `tests/e2e/stage5.ts` | browser walk |
| modified | `docs/ARCHITECTURE.md` §5.5, §5.6 · `docs/SCHEMA.md` §3, §4, §5, §9, §10, §12 | as built |

## Schema changes

| Migration | Change | Reversible? |
|---|---|---|
| `0006_search_eta.sql` | tables above; `fold_place`; `coarsen_home_location` + `invalidate_walk_cache` triggers on `profiles`; `positions_subscriber_read`; `pg_cron` jobs `aggregate-segment-speeds` (01:30 IST) and `drop-expired-positions` (02:00 IST) | mostly — see below |

Rollback:

```sql
SELECT cron.unschedule('drop-expired-positions');     -- first: stop deleting history
SELECT cron.unschedule('aggregate-segment-speeds');
DROP POLICY positions_subscriber_read ON positions;
DROP TRIGGER profiles_invalidate_walk ON profiles;  DROP FUNCTION invalidate_walk_cache();
DROP TRIGGER profiles_coarsen_home ON profiles;     DROP FUNCTION coarsen_home_location();
DROP TABLE eta_predictions, walk_eta_cache, trip_subscriptions, segment_speed_runs, segment_speeds;
DROP FUNCTION aggregate_segment_speeds_catchup(integer), aggregate_segment_speeds(date), fold_place(text);
```

**Not reversible:** any `positions` partition the drop job has removed, and any home pin already
coarsened. `segment_speeds` and `eta_predictions` are the learned model and its accuracy record:
export them before dropping.

## Configuration

| Variable | Purpose | Where to obtain | Secret? |
|---|---|---|---|
| `OSRM_FOOT_URL` | walking times (gateway) | the local compose stack / the OSRM box | no |
| `PHOTON_URL` | area search fallback (gateway) | the local compose stack / the OSRM box | no |
| `OSRM_CAR_URL` | now also read by the **engine** (optional): `v_osrm` for ETAs | as before | no |

All three were already in `.env.example`; the gateway now refuses to start without the first two.

## Technical decisions

- **A phonetic fold beside trigrams** (`fold_place`: aspirates, long vowels, doubled letters).
  Trigrams alone ranked "kothi" nearer "Kothapet" than "Koti". Rejected: Soundex/Metaphone
  (English phonetics, wrong for Telugu/Hindi romanisation), a synonyms table (does not generalise).
- **The anchor for "nearby" is the best stop when the text matches one (≥ 0.4), else Photon.**
  So "Dilsukhnagar" returns every stop within 2 km of it; "Saroornagar" (no stop) returns the
  stops around the place. With a strong anchor, other text hits must score within 0.3 of the best,
  so an exact match does not drag in look-alikes from across the city.
- **Cache the matching, not the answer.** The 5-minute Redis cache holds which stops matched; buses
  and ETAs are joined on every request.
- **ETA frames over pub/sub, re-derived on connect.** They are per-user in scope (a student's
  stops), so they must never be replayable (invariant 9); the hash in Redis is the recovery path.
- **Announce on material change; the client counts down between.** `at` is the fix time, so a
  30 s-old announcement still shows the right remaining time.
- **Leave-now needs a LIVE bus and a fresh ETA,** and does nothing when Postgres is down: an alert
  that might fire twice is worse than one that waits for the gate.
- **The home pin is coarsened by a trigger,** not by the client, so no code path can store more.
- **Weekday class stored in `weekday` as 7/8** rather than a new column: the four ARCH rungs map
  one-to-one onto the existing COALESCE key.
- **Incremental merge by sample-count weighting** (approximate after the first night) rather than
  keeping raw samples past the 90-day retention promise.

## Gotchas and failure modes

- **Symptom:** learned history was silently ignored after an out-of-order fix; ETAs fell back to
  cold start. **Cause:** the history cache aged on the fix's timestamp; an older fix made the age
  negative and the cache "fresh" for as long as the gap. **Fix:** age on the wall clock.
  **Prevention:** `eta.test.ts` feeds an older fix after a newer one.

- **Symptom:** "kothi" found Kothapet. **Cause:** trigram word-similarity rewards the shared
  prefix. **Fix:** `fold_place`. **Prevention:** 20 hand-written misspellings plus a look-alike
  test in `search.test.ts`.

- **Symptom:** the area search for Dilsukhnagar included LB Nagar (2.9 km). **Cause:** a weak
  fuzzy hit on "nagar". **Fix:** with a strong anchor, keep only strong text hits.

- **Symptom:** on a circular route, the ETA to a stop served twice was the *second* pass.
  **Cause:** `trip:{id}:eta` is keyed by stop id, and the later pass overwrote the first.
  **Fix:** keep the first (soonest) pass. Found while writing SCHEMA §10, not by a test.

- **Symptom:** a test setting a timetable offset failed with "its stops are frozen".
  **Cause:** correct behaviour: published routes are immutable (ADR-0003). **Fix:** set
  `scheduled_offset_s` before publishing. Worth knowing for Stage 7's timetable editor: the
  timetable must be part of the draft, or live beside the route rather than in `route_stops`.

- **Symptom:** a student's own pin update read back as NULL in a test. **Cause:** the PGlite
  harness's `as()` rolls its transaction back. **Fix:** assert on `RETURNING`.

- **Watch for:** OSRM free-flow speeds from routing through the route's own points every 200 m.
  A point snapped onto the far carriageway produces a U-turn leg; legs over 3 × 200 m are dropped.
  A route with many such legs will lean on history and live speed, which is the honest fallback.

## Verifying locally

```bash
pnpm test                                        # includes search (20 misspellings), ETA, leave-now
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  pnpm vitest run packages/db apps/engine apps/gateway

# live, with pnpm dev and a simulator running:
node --experimental-strip-types tests/e2e/stage5.ts --q kothi      # pin → search → stop → take bus → hero
pnpm sim eta-report --since <run start> --bus SIM-                 # accuracy per horizon
redis-cli XRANGE stream:notify - +                                 # leave_now events (Stage 6 consumes)
```

## Performance

| Metric | Target | Measured | Conditions |
|---|---|---|---|
| Fuzzy search: right stop first | 20 / 20 misspellings | **20 / 20** | `search.test.ts`, real Hyderabad names and positions |
| Area search "Dilsukhnagar" | every served stop ≤ 2 km, with buses | **exactly the PostGIS truth set**, every result with its buses; unserved stop excluded | same |
| Walking ETA vs a stopwatch-timed walk | within 20 % | **not measured — needs a person to walk it** | — |
| **Soak gate:** bus ETA MAE at 10 min, ≥ 10 real trips | < 90 s | **not measured — needs real buses** | blocks Stage 6 |
| Pipeline baseline, *simulated* trips | (not the gate) | see [`benchmarks/eta-accuracy-v1.md`](../benchmarks/eta-accuracy-v1.md) | cold start, synthetic traffic |
| Leave-now, live | once per (student, trip) | **fired once** (`etaP50S` 426 vs 6,425 s walk); still one event after 12 further ticks | real stack, 8 simulated buses |
| Student path in a browser | works | **pin saved → "kothi" → Koti → walk 1 min 33 s → Take Bus → "Bus SIM-02 · 34–45 min", "Leave in 17 min", 6-stop timeline; no page errors** | headless Chrome, 430 px wide |

## Rolling back

The SQL above, then remove the Stage 5 routes, workers and pages listed in Components. Redis:
`DEL stream:notify`; `trip:*:eta`, `route:*:osrm` and `search:stops:*` expire on their own.

## Carried forward

- **Stage 5 exit (soak gate, blocks Stage 6):** ≥10 real trips on one route with the driver app,
  then `pnpm sim eta-report --since <soak start>` without `--bus SIM-`. Tune the §5.5 weights on
  that, not on the simulator. Arranged with the Stage 1 survey driver.
- **Stage 5 exit:** a stopwatch-timed walk from a pinned home to a stop, compared with the
  stop page's walking time (within 20 %).
- **Stage 6:** consume `stream:notify` (`leave_now`) → T1 delivery; favourites (main / starred /
  muted) with their A-vs-B RLS cases; "I'm on the bus" moves the subscription to `boarded`.
- **Stage 7:** something must create `status = 'scheduled'` trips with `scheduled_start_at` (the
  timetable or event-day CSV) for "scheduled · 07:40" to appear; the timetable offsets cannot live
  in `route_stops` of a published route (it is frozen).
- **Stage 8:** an ETA-accuracy dashboard from `eta_predictions` (MAE per horizon per route).
