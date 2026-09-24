---
stage: M03
title: Live delivery
status: complete
started: 2026-09-23
completed: 2026-09-23
---

# M03 — Live delivery

## Summary

Students can now watch the fleet. A signed-in student opens the app and sees every running bus
on a themed map of Hyderabad, gliding between GPS fixes, coloured and shaped by whether it is
reporting. A bus that stops reporting turns amber with "last seen 17 s ago", then red with "no
signal since 07:42", and leaves the map ten minutes later. A parked bus reporting at the slow
cadence stays green. The stream survives a dropped network and a killed gateway without a page
reload, and replays what the student missed.

All six exit criteria are met, each against the real stack in a real browser. The measured
numbers are in **Performance**.

## Scope delivered

- [x] `GET /v1/stream` (JWT in the `Authorization` header), per-connection focus,
      `POST /v1/stream/focus`, 15 s heartbeat comments
- [x] `Last-Event-ID` replay from `stream:events`, **broadcast-class only**, re-checked per entry,
      with `replayTruncated` when the stream was trimmed past the client's id
- [x] 3-stream cap on per-connection TTL keys (45 s, refreshed by the heartbeat), claimed before
      counting; a restarted gateway deletes its own leftover keys at boot
- [x] `engine/presence.ts`: 5 s sweeper, LIVE → DEGRADED → DARK → ENDED at 3× / 9× / 9× + 600 s
      of the reported cadence; `signal_outages` opened and closed; dead-zone classification;
      `trips.status` dark ↔ running
- [x] Student live map: MapLibre on our tiles, route polylines, stops, presence-styled markers,
      dead reckoning (`lib/map/interpolate.ts`), bus detail sheet, visible OSM credit
- [x] Honest degradation UI: amber + "last seen …", red + time or dead-zone explanation, removal
      on ENDED, "off its usual route"
- [x] Zustand fleet store fed by a fetch-based SSE client with reconnect, backoff, a silence
      watchdog and a visible connection indicator
- [x] `packages/ui` design tokens, complete for both themes (fixes the carried-forward light-theme
      admin bug)
- [x] Carried forward from Stage 1–2 and done here: `trip_stop_events` written from the geo
      worker's crossings (via a `stop-events` consumer, off the live path); `fleet:live`
      rehydrated from the last 5 minutes of `positions` on engine boot; the OSM credit on the map

**Deliberately not done, and why:**

- The auto-opened signal-loss ticket after 5 minutes DARK (ARCH §5.7) needs the `tickets` table,
  which is Stage 7. The outage row it would open from is written here.
- T2 "signal lost" and T4 "known dead zone" notifications are Stage 6. The classification that
  chooses between them is here and is carried on `bus.status`.
- Dead-zone **learning** (DBSCAN) is Stage 8. The table exists and classification reads it; with
  no rows every outage is honestly "signal lost".

## Components added

| Path | What it is |
|---|---|
| `apps/gateway/src/routes/stream/index.ts` | `GET /v1/stream`, `POST /v1/stream/focus`, `Conn` (focus filtering, start-up buffer), cap, phantom reclaim |
| `apps/gateway/src/routes/stream/hub.ts` | one blocking `XREAD` per gateway process, fanned out to its connections |
| `apps/gateway/src/routes/api/network.ts` | `GET /v1/network`: published routes, stops, bus numbers (1 min cache, stale on DB error) |
| `apps/engine/src/workers/presence.ts` | the presence sweeper and `judgePresence` |
| `apps/engine/src/workers/stop-events.ts` | consumer group `stop-events` → `trip_stop_events` |
| `apps/engine/src/lib/rehydrate.ts` | `fleet:live` from recent `positions` at engine boot |
| `packages/redis/src/events.ts` | `publishEvents` on `stream:events` |
| `packages/ui/` | design tokens (CSS, both themes) and presence styles, formatters |
| `apps/web/lib/sse/` | SSE frame parser and the reconnecting fetch-based client |
| `apps/web/lib/store/` | fleet reducer (ordering rules, pure) and the Zustand binding |
| `apps/web/lib/map/interpolate.ts` | dead reckoning with its limits |
| `apps/web/components/map/live-map.tsx` | the map; markers move in a rAF loop outside React |
| `apps/web/components/live/` | stream provider and focus merge, home, bus sheet, connection badge |
| `apps/simulator/src/presence-watch.ts` | `pnpm sim watch`: judges every status transition of a live run |
| `tests/e2e/{cdp,live-map,resilience}.ts` | headless-Chrome harnesses for the exit criteria |
| `vault/decisions/ADR-0001-sse-live-channel.md` | the SSE decision, formalised |

## Files changed

Generated from the files modified in this stage (the tree is uncommitted; `git diff` has no base
to compare with). Stage 5 was built in the same session; its files are in M05.

| Status | Path | What changed and why |
|---|---|---|
| added | `packages/db/migrations/0005_live_delivery.sql` | `dead_zones`, `signal_outages` (+ `one_open_outage`), RLS |
| added | `packages/db/src/live.test.ts` | 0005 constraints and RLS |
| modified | `packages/contracts/src/tracker.ts` (+ test) | `pingDue` keeps the previous ping's cadence promise (gotcha 1) |
| modified | `packages/contracts/src/sse.ts` | `stream.ready`; routeId/tripId/seq/cadence/flag on positions; `at`/`deadZone` on status; `busId`/`event`/`backfill` on stop.reached; `StreamFocus`, `Network`, `eventBusId`, `inBBox` |
| modified | `packages/redis/src/{keys,fleet,streams,index}.ts`, `package.json` | `bus:{id}:outage`, conn-key value, `stop-events` group; presence compare-and-set, `dark_timeout` resurrection rule; `readAfter`, stream info |
| added | `packages/redis/src/events.ts` | publish broadcast events |
| modified | `apps/engine/src/workers/geo.ts` | publishes `bus.position` (coalesced) and `stop.reached`; age-judged state at ingest (gotcha 6); ENDED on trip end |
| added | `apps/engine/src/workers/{presence,stop-events}.ts`, `presence.test.ts` | sweeper, stop-events writer, tests |
| added | `apps/engine/src/lib/rehydrate.ts` | ADR-0002 rehydration |
| modified | `apps/engine/src/main.ts`, `package.json` | new workers, rehydrate at boot |
| modified | `apps/engine/src/workers/ingest.test.ts` | result shape now includes `published` |
| modified | `apps/driver/src/tracker/sampler.ts` (+ test) | cadence promise (gotcha 1) |
| modified | `apps/simulator/src/model.ts` (+ test) | cadence promise, including trace replay and the terminus |
| added | `apps/simulator/src/presence-watch.ts`; modified `cli.ts` | `sim watch` |
| added | `apps/gateway/src/routes/stream/*`, `routes/api/network.ts` | see Components |
| modified | `apps/gateway/src/{app,server,testing}.ts`, `services/jwt.ts` | hub, reclaim, stream routes; `instanceId`; token `exp` |
| added | `packages/ui/**` | tokens and tests |
| added | `apps/web/{lib/sse,lib/store,lib/map,components/map,components/live}/**`, `vitest.config.ts` | client |
| modified | `apps/web/app/(student)/{layout,page}.tsx`, `app/globals.css`, `next.config.ts`, `package.json`, `public/map/busmitra-dark.json` | provider, map home, tokens, attribution, zustand |
| added | `tests/e2e/{cdp,live-map,resilience}.ts` | harnesses (replaces `tests/e2e/.gitkeep`) |
| modified | `docs/ARCHITECTURE.md` §2.4, §4, §5.7, §7 · `docs/SCHEMA.md` §3, §10 | as built (see Technical decisions) |

## Schema changes

| Migration | Change | Reversible? |
|---|---|---|
| `0005_live_delivery.sql` | `dead_zones`, `signal_outages` with `one_open_outage`, RLS | yes — `DROP TABLE signal_outages, dead_zones;` loses the outage log, which is the Stage 8 training set: export it first |

## Configuration

No new environment variables. The gateway's instance id defaults to `hostname:GATEWAY_PORT`,
which must be stable across restarts of the same instance (Fly machine ids are).

## Technical decisions

- **Fetch-based SSE client, not `EventSource`.** `EventSource` cannot send an `Authorization`
  header, and a token in the query string lands in access logs. The client does EventSource's
  job explicitly (ADR-0001).
- **Focus lives in the connection's own TTL key.** Any gateway instance can accept the POST; the
  key embeds the user id, so another student's `connId` is a 404. Rejected: in-memory focus (breaks
  with two instances), a separate focus key (a second thing to expire).
- **Claim first, count second** for the stream cap. Two racing connects can both be refused but
  never both admitted. Rejected: a Lua `KEYS` count (O(keyspace)).
- **Phantom reclaim at boot** by instance id, on top of the 45 s TTL. A killed-and-restarted
  gateway locks nobody out even for 45 s (measured: 1 key reclaimed, reconnect in 2.6 s).
- **ENDED by timeout does not close the trip** (`dark_timeout`). A tracker that returns after
  ten minutes is a bus that is really there. An explicit END stays final. ARCH §5.7 updated.
- **Stop events go to Postgres through a consumer on `stream:events`**, not from the geo worker,
  so the database stays off the live path. The stream is trimmed at 50 k entries (~2 h at full
  fleet), which bounds how long that consumer may lag.
- **The snapshot replaces the client's fleet;** positions and statuses are applied only if not
  older than what is held. Replay → snapshot → buffered live frames is then correct by
  construction.
- **Markers are DOM `Marker`s moved in one rAF loop**, not a GeoJSON source re-uploaded per
  frame: 30 GPU-composited transforms, no worker round-trip.

## Gotchas and failure modes

- **Symptom:** (found by reading, before any code) a parked bus would go amber at every stop.
  **Cause:** after 30 s still, the tracker slows from 5 s to 15 s, but the last ping on record
  still advertises 5 s; the next arrives 15 s + batch hold later, past 3 × 5 s.
  **Fix:** `pingDue(lastAt, at, cadence, lastCadence)` — the next ping is due at the sooner of the
  current cadence and the previous ping's promise. Driver app, simulator, trace replay, terminus.
  **Prevention:** a simulator property test over five seeds (no gap exceeds the previous fix's
  advertised cadence) and a sampler test. Measured live: 258 fixes at the 15 s cadence over two
  runs, zero false alarms.

- **Symptom:** the outage stayed "open" in Redis after the bus recovered.
  **Cause:** `tryDb(() => closeOutage(…))` returns `undefined` for a void function, and
  `undefined` was also the failure value.
  **Fix:** the closure returns `true`. **Prevention:** the recovery test asserts the key is gone.

- **Symptom:** `Last-Event-ID` older than the stream was never reported as truncated.
  **Cause:** first tried "is the id older than the first entry" (true even when nothing was
  lost), then Redis 7's `max-deleted-entry-id` (tracks `XDEL`, **not** `MAXLEN` trims).
  **Fix:** trimmed ⇔ `entries-added > length` and the id is older than the first survivor.
  Conservative: can flag a resume that lost nothing, never the reverse.

- **Symptom:** a 124 s ping-to-pixel sample in the 30-bus run.
  **Cause (most likely, not proven — the harness did not keep raw samples then):** a bus's
  reconnect flush read in two slices by the geo worker; the first slice's newest fix is minutes
  old but was published and drawn as LIVE for a moment — a fabricated position.
  **Fix:** the geo worker judges each written fix by its age at ingest (`presenceAtIngest`), and
  the client reducer judges each position by its age on the gateway clock (`presenceByAge`).
  **Prevention:** unit tests on both; the harness now records every sample over 10 s with its bus.

- **Symptom:** the browser harness hung forever, reporting nothing.
  **Cause:** a CDP `Runtime.evaluate` pending across a page reload never resolves.
  **Fix:** a 30 s deadline on every CDP call, and the harness voids the run if the page reloads.

- **Symptom:** the first smoke simulation "died" when its shell returned.
  **Cause:** a background process started inside a tool call's shell is killed with it.
  **Fix:** long runs are background tasks in their own right. Trivial; cost twenty minutes.

- **Symptom:** a simulated bus meant to be offline for 13 minutes reappeared after 2.
  **Cause:** the simulator's airplane window applies to the first trip; the reconnect flush was due
  after the run ended, so the loop moved on to a second trip. A simulator quirk, not a product one.
  **Fix:** end the offline window before the run ends (`--airplane 7:1:14` in a 16-minute run).

- **Symptom:** a second simulator run started while one was still going failed every trip start
  with `401 bad_signature`, and broke the first run's batches too.
  **Cause:** each run re-provisions the same `SIM-*` trackers with new secrets, and the gateway
  caches decrypted secrets for 60 s (SCHEMA §2).
  **Fix:** never run two simulator fleets at once. The real consequence — a freshly rotated phone
  can be refused for up to a minute — is carried forward to Stage 7's pairing screen.

- **Symptom:** clicking the settings map in the headless browser placed no pin.
  **Cause:** the map was below the fold; a synthetic click outside the viewport hits nothing.
  **Fix:** `scrollIntoView` before computing the click point.

- **Watch for:** the presence sweeper uses the tracker's own `recorded_at`. A phone clock that is
  wrong by more than a cadence shifts every threshold; the gateway only bounds skew at ±5 min.

## Verifying locally

```bash
pnpm typecheck && pnpm lint && pnpm format:check
pnpm test                                     # 411 tests / 51 files
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  pnpm vitest run packages/db apps/engine apps/gateway      # 207 of them on Supabase Postgres 15

# the stack (pnpm dev), a claimed synthetic student (E2E_ROLL / E2E_PASSWORD), then:
pnpm sim run --buses 30 --minutes 16 --stagger 3 --no-dead-zones \
  --airplane 3:1:3 --airplane 7:1:14 --seed 2 &          # two buses cut off
pnpm sim watch --minutes 17 --cut SIM-03,SIM-07          # ok: true, falseAlarms: []
node --experimental-strip-types tests/e2e/live-map.ts --seconds 840     # latency, jumps, states
node --experimental-strip-types tests/e2e/resilience.ts network --offline-s 25
node --experimental-strip-types tests/e2e/resilience.ts sigkill \
  --gateway-cmd "cd apps/gateway && exec node --env-file-if-exists=../../.env src/server.ts"
```

Or by eye: open <http://localhost:3000> signed in, run the simulator, watch buses glide; cut one
off with `--airplane` and watch it turn amber at 15 s, red at 45 s, and disappear at ~10¾ min.

## Performance

All on one laptop (M-series MacBook Air) running the whole stack, headless Chrome at 1280×900.

| Metric | Target | Measured | Conditions |
|---|---|---|---|
| Buses live on the map | 30 | **30** | 30-bus run, 16 min |
| p95 ping-to-pixel | < 6 s | **4.03 s** (p50 3.02 s, n = 4,604) | GPS fix time → first animation frame drawing it, gateway clock |
| p95 ping-to-pixel, re-run | < 6 s | **4.03 s** (p50 4.01 s, p99 4.04 s, n = 470, none over 10 s) | 10-bus run, 4 min; the p50 moves with where fixes fall in the 5 s batch window |
| Largest per-frame marker move | "no visible jumps" | **30 px, one frame > 25 px in 50,424** | 30-bus run |
| DEGRADED at 3× cadence | 15 s at 5 s | **15.9 s / 18.9 s** | two cut-off buses; ≤ one 5 s sweep late |
| DARK at 9× cadence | 45 s | **45.9 s / 48.9 s** | same |
| ENDED at DARK + 10 min | 645 s | **649 s**, absent from the map from 660 s | bus 7, offline 13 min |
| False amber/red at either cadence | 0 | **0** | 5,079 positions, 121 at the 15 s cadence (second run: 4,706 / 137) |
| Recovery after an outage | back to LIVE | **both cut-off buses recovered**, outages closed | incl. after ENDED by timeout |
| Network cut 25 s mid-stream | reconnect + replay, no reload | **live again 0.2 s after the network returned; 55 frames replayed** (positions + stop arrivals); `Last-Event-ID` sent; no reload | CDP offline emulation |
| Gateway `SIGKILL` + restart | nobody locked out | **1 phantom key reclaimed at boot; live again 2.6 s after restart; 1 connection key** | no reload |
| Ingest during the runs | no loss | **5,355 → 5,355** rows, 163/163 backfill flagged | 30-bus run |

## Rolling back

Code: remove `apps/gateway/src/routes/stream`, `routes/api/network.ts`, the engine's presence,
stop-events and rehydrate, `packages/ui`, and the web client directories above; restore the
Stage 2 `app.ts`, `main.ts` and student home. Database: `DROP TABLE signal_outages, dead_zones;`
(export `signal_outages` first). Redis: `DEL stream:events`; `bus:*:outage` and `sse:conn:*`
expire on their own. Keep the `pingDue` change even when rolling back: it fixes a false alarm
that exists without Stage 3 too.

## Carried forward

- **Stage 6:** deliver T2 "signal lost" / T4 "known dead zone" from `bus.status` reasons
  `signal_lost` / `known_dead_zone`, never for backfill-derived events (`stop.reached.backfill`).
- **Stage 7:** auto-open a signal-loss ticket when a `signal_outages` row stays open 5 minutes.
- **Stage 7:** after a secret rotation the gateway can refuse the new secret for up to 60 s (the
  decrypted-secret cache). The pairing screen should refresh the tracker directory on rotation,
  or the directory should re-read once on a signature miss.
- **Stage 8:** dead-zone learning fills `dead_zones`; an admin overlay; `stream:pings:dead` and
  `stop-events` consumer lag on the observability page.
- **Stage 8:** the SSE cap counts with `SCAN` per connect; fine at 600 clients, measure at 1,000.
- **Stage 9:** HTTP/2 at the edge, or a student with several tabs meets the six-connection limit.
