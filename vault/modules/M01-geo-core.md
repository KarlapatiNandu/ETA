---
stage: M01
title: Geo core and route capture
status: in-progress
started: 2026-09-22
completed: —
---

# M01 — Geo core and route capture

## Summary

The mathematical heart of the product exists and is proven against adversarial fixtures:
`packages/geo` turns a stream of GPS fixes into a route offset, honest progress, stop
crossings and an ETA range — pure, dependency-free, 100% of lines covered. Around it sits the
tooling that produces route data where there was none: survey mode in the driver app, a
trace → map-matched-route pipeline that chunks OSRM `/match` and stitches the answers, an
admin route editor on our own vector tiles, and a deterministic fleet simulator that every
later stage will test against.

**Status is in-progress, not complete.** Everything is built and tested, and the pipeline has
been verified end to end against the real self-hosted OSRM. One exit criterion needs a bus:
no real route has been surveyed yet — the routes in the database are synthetic corridors
generated through the same pipeline. See *Carried forward*.

## Scope delivered

- [x] `packages/geo`: `haversine`, `projectPointOnSegment`, `buildCumulativeDistances`, plus
      `pointAtOffset`, `headingAtOffset`, `segmentAt`, `offsetPoint`
- [x] `snapToRoute` — forward-biased window + off-route detection (ARCH §5.2)
- [x] `enforceMonotonicProgress` — **including the global re-snap after 4 backward fixes** (§5.3)
- [x] `detectCrossings` — **including the `skipped` rule** (§5.4), plus `finishCrossings` for
      explicit trip end (see *Technical decisions*)
- [x] `computeEta` → `{p50S, p90S, confidence}` with the `v_hist` fallback ladder (§5.5)
- [x] `simplifyTrace` (Douglas–Peucker, iterative) and `dedupe`
- [x] `stepTrip` — the whole §5.2–5.4 chain as one pure reducer, which is what the engine runs
- [x] Driver PWA survey mode — 1 Hz dense capture, raw trace uploaded untouched to Storage
- [x] Trace → route pipeline: clean → simplify → OSRM `/match` **chunked 80 points / 15 overlap**
      → stitch → canonical polyline → draft route with a new or inherited `lineage_id`
- [x] Admin route editor: drag vertices, insert by dragging a midpoint, right-click to delete,
      drop stops (projected onto the line), name/alias them, publish with a repeated-stop
      confirmation, create a new version, discard a draft
- [x] Simulator: N buses on real routes, σ ≈ 8 m noise, dead zones, off-route excursions,
      stalls, duplicate and out-of-order batches; deterministic trace replay
- [x] `packages/db` schema for `routes`, `stops`, `route_stops` (+ `buses`, `trackers`,
      `route_surveys`) with RLS on every table
- [ ] **Not done:** a real route surveyed by driving it. Needs a bus and a driver.

**Deliberately not done, and why:**

- *Stop-arrival persistence.* `stepTrip` computes crossings and they drive `trip:{id}:seq`, but
  nothing writes `trip_stop_events` or publishes `stop.reached` yet: the geofence worker and the
  SSE event are Stage 3's scope (BUILD_PLAN puts `stop.reached` there). The maths is done and
  tested so Stage 3 only has to wire it.
- *Moving an existing stop's location in the editor.* It would change what a published route's
  frozen `cumulative_dist_m` refers to (ADR-0003). Only text fields are editable; a moved stop
  is a new stop. Enforcing that in the database belongs with Stage 7's stop management.
- *Route scheduling.* `trips.scheduled_start_at` and timetables are Stage 7.

## Components added

| Path | What it is |
|---|---|
| `packages/geo/**` | the pure geo core: geometry, snap, progress, crossings, eta, simplify, match helpers, `stepTrip`, and a test kit for synthetic routes |
| `packages/db/migrations/0003_geography.sql` | routes, stops, route_stops, buses, trackers, route_surveys; derived-distance, immutability and frozen-stop triggers; RLS; `audit_row()` fix |
| `packages/contracts/src/routes.ts` | admin editor ↔ gateway: `SaveDraft`, `DraftStop`, `RouteDetail`, `MatchSurvey`, `PublishRoute`, `StopSearchHit` |
| `packages/contracts/src/ingest.ts` | `SurveyUpload`, `SurveyPoint`, `SurveyAccepted` (with the Stage 2 tracker contracts) |
| `apps/engine/src/osrm.ts` | the OSRM client: `/match` (chunked by the caller) and `/route` |
| `apps/engine/src/workers/survey.ts` | the trace → route pipeline and `matchSurvey` |
| `apps/engine/src/routes.ts` | route store: `loadRoute` for the workers, `saveDraft`, `publishRoute`, `newVersion`, `deleteDraft` |
| `apps/gateway/src/routes/api/admin/routes.ts` | the editor's API, all mutations audited |
| `apps/gateway/src/routes/tracker/index.ts` | `POST /v1/survey` (signed) with the Stage 2 tracker endpoints |
| `apps/web/app/(admin)/admin/routes/**` | surveys + routes list, and the editor page |
| `apps/web/components/admin/route-editor.tsx` | the MapLibre editor |
| `apps/web/public/map/busmitra-dark.json`, `apps/web/app/api/map-style/route.ts` | our own dark map style, served with the tile server's address filled in |
| `apps/simulator/**` | the deterministic bus/tracker model, route seeding, the runner, the verifier and the CLI |

## Schema changes

| Migration | Change | Reversible? |
|---|---|---|
| `0003_geography.sql` | `survey_status_t`; tables `routes`, `stops`, `route_stops`, `buses`, `trackers`, `route_surveys`; functions `routes_derive_distances()`, `routes_guard()`, `route_stops_guard()`; `CREATE OR REPLACE FUNCTION audit_row()` (bug fix, see Gotchas); audit triggers; RLS + column grants | yes, with data loss: `DROP TABLE route_surveys, route_stops, trackers, buses, stops, routes CASCADE; DROP FUNCTION routes_derive_distances(), routes_guard(), route_stops_guard(); DROP TYPE survey_status_t;` then re-run 0002's `audit_row()` definition |

`SCHEMA.md` was updated in the same change: `trackers.secret_prev_enc`, the `route_surveys`
table, `survey_status_t`, and the RLS rows for the new tables.

## Configuration

| Variable | Purpose | Where to obtain | Secret? |
|---|---|---|---|
| `NEXT_PUBLIC_TILES_URL` | the tile server the editor's map loads (ADR-0005); defaults to `http://localhost:8080` so only the editor needs it | `docker compose` | no |
| `DRIVER_ORIGIN` | the driver PWA's origin — CORS, and the pairing links the tracker CLI prints | deployment | no |
| `OSRM_CAR_URL` | already in `.env.example`; the gateway now needs it too, for survey matching | compose | no |

A private Storage bucket **`route-surveys`** holds raw traces (`infra/supabase/config.toml`).
On a stack that is already running, `supabase start` will not create it — see *Verifying*.

## Technical decisions

- **One sphere, everywhere.** `cumulative_dist_m` is computed in SQL by trigger, and stop
  offsets are computed in TypeScript. They must agree, so both use the PostGIS *sphere*
  (`ST_Distance(…, use_spheroid => false)`, R = 6371008.7714) rather than the WGS84 spheroid.
  The difference is ~0.3%, which is 75 m over a 40 km route — most of the 100 m
  arrival-confirmation margin. `geography.test.ts` asserts the two agree to the millimetre.
- **`finishCrossings` for explicit trip end.** A terminal stop at the very end of the route can
  never reach the "100 m past" drive-through rule, so it confirms only if the bus stops there.
  Buses do stop at the terminus, but the trip-end message resolves a still-pending candidate so
  a trip cannot end with its last stop unrecorded. Found by a fixture, not by reasoning.
- **Stops are placed by projection, with the click as a hint.** `projectStops` picks the *pass*
  nearest the offset where the admin clicked, which is what makes a circular route serving the
  same stop twice work at all. Without a hint it takes the first pass after the previous stop.
- **Out-of-order stops are refused (422), stops far from the line are only a warning.** The
  crossing detector enforces sequence, so a stop that can only sit behind its predecessor would
  wait for ever; 50 m off the line is often just a wide junction.
- **The editor computes offsets client-side too.** The same `packages/geo` functions run in the
  browser so the stop list re-orders as you drag, and the server recomputes authoritatively on
  save. One implementation, two callers — the reason geo has no dependencies.
- **Our own map style.** tileserver-gl's bundled `basic-preview` asks for fonts the server does
  not have (see Gotchas). We ship `busmitra-dark.json` instead, which also delivers the
  restyling ADR-0005 promised. Stage 3 will extend it for the student map.
- **Seed corridors are `osrm_derived`, never `gps_survey`.** The eight simulator routes are real
  Hyderabad roads, but their traces are synthetic. They are labelled as what they are so nobody
  mistakes them for surveyed data.

## Gotchas and failure modes

- **Symptom:** every `INSERT` into `route_stops` failed with *record "new" has no field "id"*.
  **Cause:** `audit_row()` (from 0002) tested `… AND TG_OP = 'UPDATE' AND candidate = NEW.id`.
  PL/pgSQL resolves record fields even when an earlier operand is false, and `route_stops` has
  no `id` column.
  **Fix:** read the id from the jsonb image (`(a->>'id')::uuid`) — `CREATE OR REPLACE` in 0003.
  **Prevention:** `geography.test.ts` audits a table without an `id`; any future audited table
  without one is covered.

- **Symptom:** in the test harness, every audited service-role write after the first
  `db.as(...)` call failed with *invalid input syntax for type json*.
  **Cause:** the Supabase stub's `auth.uid()` did `current_setting('request.jwt.claims', true)::jsonb`.
  Once a transaction-local `set_config` has been rolled back, that setting reads `''` — not
  NULL — for the rest of the session, and `''::jsonb` throws. Real Supabase guards with
  `nullif(…, '')` first; the stub claimed to be identical and was not.
  **Fix:** `NULLIF(current_setting(...), '')::jsonb` in the stub.
  **Prevention:** the comment in `supabase-stub.sql` now says why the NULLIF is load-bearing.

- **Symptom:** the route editor rendered its sidebar but the map area stayed empty — no canvas,
  no errors.
  **Cause:** the map container was rendered only once the route had loaded, but the map-setup
  effect runs once on mount, when `mapEl.current` was still null. It never ran again.
  **Fix:** the container is always mounted; only the sidebar waits for data.
  **Prevention:** the browser walkthrough (`scratchpad/ui/final.mjs`, not committed) asserts a
  canvas exists. A real browser was the only thing that could have found this — typecheck,
  lint and the API tests were all green.

- **Symptom:** saving a draft from the editor failed with "Failed to fetch"; the same request
  with `curl` succeeded in 26 ms.
  **Cause:** `@fastify/cors` allows `GET, HEAD, POST` by default. The editor's `PUT` (save) and
  `DELETE` (discard) never got past the preflight. `app.inject()` bypasses CORS entirely, so no
  server-side test could see it.
  **Fix:** an explicit `methods` list on the CORS plugin.
  **Prevention:** `routes.test.ts` now asserts the preflight allows PUT and DELETE.

- **Symptom:** discarding a draft threw *Body cannot be empty when content-type is set to
  'application/json'*.
  **Cause:** the web `gateway()` helper always set a JSON content-type, including on a DELETE
  with no body, which Fastify refuses.
  **Fix:** set the header only when a body is actually sent.

- **Symptom:** no labels anywhere on the map — no street names, no place names, no stop names.
  **Cause:** tileserver-gl serves exactly one font stack, `Noto Sans Regular`. The bundled
  `basic-preview` style asks for `Open Sans Regular,Arial Unicode MS Regular`, so every glyph
  request returned 400 and MapLibre silently dropped every symbol layer.
  **Fix:** our own style, and `"text-font": ["Noto Sans Regular"]` on our stop labels.
  **Prevention:** written down here and in the style's `metadata`. Anyone adding a symbol layer
  must use a font the server actually has (`GET /fonts.json` lists them).

- **Symptom:** simplification barely reduced a survey — 468 points became 155.
  **Cause:** Douglas–Peucker with ε = 4 m against GPS noise of σ ≈ 6–8 m keeps the noise.
  **Fix:** ε = 10 m, at GPS-noise scale. Safe because the *output* geometry comes from OSRM's
  road network; the kept points only have to be on the right road.
  **Prevention:** `survey.test.ts` asserts the trace shrinks by more than 5×.

- **Symptom:** after simplification, some gaps between kept points were 262 m — past the 250 m
  limit that keeps OSRM from routing a different way round.
  **Cause:** the gap-filler kept the first point *past* the limit instead of the last point
  before it.
  **Fix:** look one point ahead.
  **Prevention:** the test asserts every gap is under 260 m on a real trace.

- **Symptom:** the RLS coverage test failed on real Postgres but passed on PGlite, claiming 11
  partitions had grants.
  **Cause:** node-pg returns `information_schema`'s domain-typed arrays as the raw string
  `"{}"`, whose `.length` is 2.
  **Fix:** count in SQL instead of measuring an array in JavaScript.
  **Prevention:** a comment at the query; a reminder that PGlite and node-pg do not decode
  every type the same way.

- **Symptom:** the positions idempotency test failed on Supabase Postgres 15 and passed on PGlite.
  **Cause:** the test read `recorded_at` back as a JS `Date` (millisecond precision) and
  re-inserted it; `now()` has microseconds, so the "same instant" was a different instant.
  **Fix:** the test uses a fixed, second-aligned timestamp — which is also what the persister
  writes (the tracker's `recorded_at`, from a JSON string).
  **Prevention:** both engines run in CI (`postgres15` job).

- **Symptom:** a stop added in the editor was labelled "served twice".
  **Cause:** the repeat check matched on `stopId`, and every *new* stop has none, so
  `findIndex` returned −1 and disagreed with the row's own index.
  **Fix:** only an existing stop can repeat.

- **Watch for:** the seeded corridors are **longer than a real bus route** (41 km for
  Dilsukhnagar → CBIT). OSRM routes the fastest *car* path through approximate locality
  coordinates, which takes ring roads. The pipeline is faithful — the matched length is within
  ~1% of OSRM's own route every time — but do not read the seed data as a plausible timetable.

## Verifying locally

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm format:check
pnpm test                       # 306 tests / 39 files
pnpm vitest run packages/geo --coverage    # 100% lines, 97.4% branches

# with the stack up (pnpm dev). The survey bucket is created by `supabase start`; on a stack
# that was already running when 0003 landed, create it once:
#   curl -X POST "$SUPABASE_URL/storage/v1/bucket" -H "authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
#        -H 'content-type: application/json' \
#        -d '{"id":"route-surveys","name":"route-surveys","public":false,"allowed_mime_types":["application/json"]}'

pnpm sim seed                   # 8 corridors on real roads, through the real pipeline
# expected: "seeded SIM R1 Dilsukhnagar: 41.4 km, 19 OSRM chunks, 96.4% matched" ×8, in ~3 s
```

For a browser check you need an admin. Claim one through the UI (`TDADMIN01`, then the
promotion SQL in `infra/supabase/seed.sql`), or mint a synthetic one with the service role:

```bash
# 1. create the auth user (service role)
curl -s -X POST "$SUPABASE_URL/auth/v1/admin/users" \
  -H "authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H 'content-type: application/json' \
  -d '{"email":"simadmin01@students.busmitra.internal","password":"<generated>","email_confirm":true}'
# 2. give it a roster row and a td_admin profile (psql, service role) using the id it returned
```

⚠️ Such an account can be **demoted but not deleted** once it has done anything audited:
`audit_log.actor_id` references `profiles`, on purpose — an audit trail whose actor can be
erased is not an audit trail. `UPDATE profiles SET role = 'student' WHERE roll_no = '…'` is the
way to retire one.

Then, as a TD admin, open `/admin/routes`: the eight routes are listed, each opens in the
editor with its polyline and stops on the dark map. "Edit as a new version" makes v2, dragging
a white vertex changes the length in the sidebar, "Add stops" places a stop on the line at the
nearest point, "Save draft" persists and re-projects every offset, "Discard draft" removes it.

The pipeline also has a live-OSRM test that runs whenever OSRM is up (skipped otherwise):

```bash
pnpm vitest run apps/engine/src/workers/survey.test.ts
# "the pipeline against real OSRM > matches a noisy 1 Hz trace of a real road back onto that road"
```

## Performance

| Metric | Target | Measured | Conditions |
|---|---|---|---|
| `packages/geo` line coverage | > 90% | **100%** (branches 97.4%) | 83 tests, 0.4 s |
| geo test suite | — | **~0.4 s** | whole package, no I/O |
| Map-matching a 45-minute survey | — | **19 OSRM `/match` calls, < 0.4 s total** | 2,700 points → ~150 after cleaning, self-hosted OSRM, Hyderabad extract |
| Matched length vs OSRM's own route | within a few % | **0.5–2%** (e.g. 41.42 km matched vs 40.9 km truth) | 8 corridors, 90.7–96.6% of points matched |
| Matched geometry vs truth, vertex by vertex | — | **every vertex within 15 m** | live-OSRM test, Dilsukhnagar → Malakpet |
| Seeding 8 routes (route + survey + match + stops + publish) | — | **3.3 s** | one OSRM instance, local Supabase |
| Editor load, 41 km route | — | 643 vertices, map interactive in ~2 s | Chrome, local tiles |

## Rolling back

Code: remove `packages/geo`, `apps/simulator`, `apps/engine/src/{osrm,routes}.ts`,
`apps/engine/src/workers/survey.ts`, `apps/gateway/src/routes/api/admin/routes.ts`,
`apps/web/app/(admin)/admin/routes`, `apps/web/components/admin/route-editor.tsx`.
Database: the `0003` rollback above (it drops every route, stop and survey — export first if
any route has been published for real).

## Carried forward

- **Exit, needs a bus:** survey one real route with the driver app, match it, correct it in the
  editor and publish it. Everything the criterion needs is built; it needs a driver and ~45
  minutes of driving. Arrange with the Stage 5 soak driver (tracker §2).
- **Stage 3:** wire `stepTrip`'s crossing events to `trip_stop_events` and the `stop.reached`
  SSE frame. The events are computed and tested already.
- **Stage 3:** the map style is deliberately minimal. Extend `busmitra-dark.json` for the
  student map, and show the required "© OpenMapTiles © OpenStreetMap contributors" credit
  (MapLibre's default attribution control does this today).
- **Stage 3/7:** light theme. The admin shell renders a light canvas with dark panels under
  `prefers-color-scheme: light` — the Stage 4 tokens only half-cover it. Fix when
  `packages/ui` lands.
- **Stage 7:** stop management (rename, merge, archive, move) and the guard that prevents
  moving a stop that a published route depends on.
- **Stage 7:** tracker pairing is a CLI (`pnpm tracker provision|rotate`); the admin console
  needs a pairing screen with a QR code.
- The editor exposes `window.__routeMap` in development only, for debugging and browser tests.
