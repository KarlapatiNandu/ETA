# Bus Mitra — Stage Tracker

> **Review this before building each stage, and update it the moment anything changes.**
> Working rules live in [Read_this_first.md](Read_this_first.md). Stage detail lives in [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md).
>
> Exit criteria below are transcribed from the build plan so they can be ticked in place. If the two ever disagree, the build plan wins and this file is stale — fix it.

**Last updated:** 2026-09-25 · **Current stage:** **every stage is built.** Stage 8 built and measured (600 + 1,000-student load runs, five chaos drills, dead-zone learning verified against injected zones); open: the real-route dead-zone soak. Stage 9 built and proven locally (images, deploy configs, restore drill, CSP in a browser, GT06 adapter); open: provisioning production, the pilot, a physical tracker — all need accounts, money, devices or time. Stage 3 complete; Stages 0, 4, 1, 2, 5, 7, 6 built with open non-code exits (see each). **The Stage 5 ETA soak gate (≥10 real trips) is still the most important open item.** · **Repo state:** Stages 0–7 committed by the owner as `09c10b4` (CI green); Stages 8–9 committed on top

---

## 1. Status at a glance

| # | Stage | Build order | Status | Started | Completed | Vault entry |
|---|---|---|---|---|---|---|
| 0 | Foundations | 1st | 🟡 In progress — open: outreach (CI now green on GitHub) | 2026-09-22 | — | `M00-foundations.md` |
| 4 | Identity and roster | 2nd | 🟡 In progress — open: real SMS (DLT) | 2026-09-22 | — | `M04-identity.md` |
| 1 | Geo core and route capture | 3rd (pure-geo half runs with Stage 4) | 🟡 In progress — open: one real route surveyed | 2026-09-22 | — | `M01-geo-core.md` |
| 2 | Ingestion pipeline | 4th | 🟡 In progress — open: airplane test on a physical phone | 2026-09-22 | — | `M02-ingestion.md` |
| 3 | Live delivery | 5th | 🟢 Complete | 2026-09-23 | 2026-09-23 | `M03-live-delivery.md` |
| 5 | Stops, search and personal ETA | 6th (parallel with 7) | 🟡 Built — open: stopwatch walk, **ETA soak gate** | 2026-09-23 | — | `M05-search-eta.md` |
| 7 | Admin console | 6th (parallel with 5) | 🟡 Built — open: TD usability session | 2026-09-23 | — | `M07-admin-console.md` |
| 6 | Notification spine | 7th | 🟡 Built ahead of its gate — open: iPhone, phone latency, real SMS, Stage 5 soak | 2026-09-24 | — | `M06-notifications.md` |
| 8 | Learning, observability and load | 8th | 🔵 Built and measured — open: dead-zone soak on real routes | 2026-09-24 | — | `M08-observability.md` |
| 9 | Production and hardware | 9th | 🟡 Built, proven locally — open: provision production, pilot, physical tracker 👥 | 2026-09-24 | — | `M09-production.md` |

Status values: ⬜ Not started · 🟡 In progress · 🟢 Complete · 🔵 Complete except soak gate · 🔴 Blocked

**Build order:** `0 → 4 → 1 → 2 → 3 → 5/7 → 6 → 8 → 9`. Stage numbers are identities, not an order.

---

## 2. External dependencies — the things with multi-week clocks

These stall the build if left unchased. Update the moment anything moves.

| Dependency | Requested on | Status | Blocks | Notes |
|---|---|---|---|---|
| MSG91 DLT registration — entity, sender header, **and a content template per tier** | — | 🟡 Drafted (`docs/OUTREACH.md` §1), not submitted | Stage 6 (SMS), Stage 4 (OTP claim) | 1–2 week regulatory clock. Start on day one of Stage 0. Draft T0/T1 template text even though copy is not final. |
| TD roster CSV (roll no, name, admission year, phone, branch) | — | 🟡 Request drafted (`docs/OUTREACH.md` §2), not sent | Stage 4 | Risk register rates late/incomplete as **High**. `phone_e164` is nullable for exactly this reason. |
| TD actual daily ridership figures | — | 🟡 In the same drafted letter, not sent | Stage 8 sizing, production sizing | Five-minute question. If materially above 1,500, re-derive SSE fan-out and Fly.io sizing. |
| Cooperative driver + one route for the Stage 5 ETA soak (≥10 instrumented trips) | — | ⬜ Not started | Stage 5 exit / start of Stage 6 | **Arrange during Stage 4.** ~1 week of real riding; Stage 5's 6 build-days do not contain it. |
| Cohort definition settled with TD (shift split vs academic year) | — | 🟡 Question in the drafted letter, not sent | Stage 4 RLS + audience queries | Two enum values fit a shift split and cannot express a year group. Cheap now, an enum migration later. |
| ODbL position on surveyed route geometry | — | 🟡 Written up: ADR-0010 recommends publishing routes + stops under ODbL — **owner to decide** | Stage 9 public release | Map-matched traces plausibly make `routes`/`stops` a Derivative Database. Ten minutes of reading now. |

---

## 3. Stages

### Stage 0 — Foundations · 🟡 In progress (all build work done & demonstrated; open: GitHub CI run, outreach sent)

**~3 days.** Nothing user-visible. Every later stage is faster or slower depending on how honestly this one is done.
**Depends on:** nothing. **Start commit:** `9cabdb2` · **End commit:** —

**Build checklist** — transcribed from `docs/BUILD_PLAN.md` · 👥 = people/external task

- [x] pnpm workspace + Turborepo pipeline; TS project references; `strict` + `noUncheckedIndexedAccess`
- [x] ESLint + Prettier + `lint-staged`; Vitest at the root
- [x] `docker-compose.dev.yml`: Supabase CLI stack, Redis 7, OSRM car + foot, Photon, Mailpit, tileserver-gl
- [x] `infra/osrm/prepare.sh` — Telangana extract (OSM France mirror; Geofabrik has none) → `osmium extract` Hyderabad bbox → extract/partition/customize, both profiles — *run: 581 MB peak RAM, ~25 s, car 340 MB + foot 258 MB*
- [x] `infra/tiles/prepare.sh` — Planetiler → `.mbtiles` for tileserver-gl (ADR-0005) — *run: 20 MB, 28 s (`--inland`)*
- [x] Artefact publishing decided — **GitHub release assets** (largest file 340 MB)
- [x] `packages/config` — Zod-parsed env, loud boot failure naming the variable; `.env.example` documents every key
- [x] `packages/contracts` — `Ping`, `PingBatch` (**with `cadence_s`**), `SseEvent`
- [x] GitHub Actions: typecheck → lint → test → build on every push
- [x] `vault/` structure + `_TEMPLATE.md`; `docs/` skeleton
- [ ] 👥 MSG91 DLT registration started — entity, sender header, **a content template per tier** (T0/T1 text drafted)
- [ ] 👥 TD asked for actual daily ridership
- [ ] 👥 TD roster CSV requested (roll no, name, admission year, phone, branch)

**Exit criteria**
- [x] `pnpm dev` starts every container, both OSRM profiles answer a test route, and the tile server returns a tile — *2026-09-22: `smoke: osrm-car ok / osrm-foot ok / tiles ok / redis ok`, then gateway + web up; CBIT→Mehdipatnam car 15.4 km / 18 min*
- [x] `pnpm test` and `pnpm typecheck` pass in CI — **green on GitHub** for `09c10b4` (2026-09-24, both jobs): https://github.com/KarlapatiNandu/ETA/actions/runs/36020689835
- [x] A missing env var fails the boot with a readable message naming the variable — `pnpm env:check` (run first by `pnpm dev`), covered by `env.test.ts`
- [ ] DLT registration submitted; roster request sent — *drafted in `docs/OUTREACH.md`, not sent*
- [x] `vault/modules/M00-foundations.md` written (measured numbers, 11 gotchas)

**Watch for:** `PingBatch` must carry `cadence_s` from the very first version — retrofitting it into a contract hardware trackers already speak is what the adapter seam exists to avoid. Clipping to the Hyderabad bbox keeps OSRM under 600 MB RAM and the artefacts under the 2 GiB release-asset cap (measured).

**Files touched this stage:** root workspace config (`package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig*.json`, `eslint.config.js`, `vitest.config.ts`, `.prettier*`, `.env.example`, `.gitignore`, `.nvmrc`) · `packages/config/**` · `packages/contracts/**` · `infra/{hyderabad.env,osrm/prepare.sh,tiles/prepare.sh,docker/docker-compose.dev.yml,supabase/config.toml,scripts/*.sh}` · `.github/workflows/ci.yml` · `docs/OUTREACH.md` · `docs/BUILD_PLAN.md`, `docs/ARCHITECTURE.md` (OSM source fix) — full table in M00

---

### Stage 4 — Identity and roster · 🟡 In progress (built, tested on real Supabase PG 15, run live; open: real SMS — blocked on DLT)

**~4 days.** Build immediately after Stage 0; the pure-geo half of Stage 1 runs alongside.
**Depends on:** Stage 0; TD roster CSV; cohort definition. **Start commit:** `9cabdb2` (uncommitted tree after Stage 0) · **End commit:** —

**Build checklist** — transcribed from `docs/BUILD_PLAN.md` · 👥 = people/external task

- [ ] 👥 Cohort definition settled with TD (shift split vs academic year) — before RLS/audience queries — *asked in drafted letter; built on junior/senior with the rule isolated in `derive_cohort()` defaults*
- [x] Supabase Auth with synthetic `<roll_no>@students.busmitra.internal` identities
- [x] Roster import: CSV → Zod parse → diff preview → confirm → `roster_students`; phone-less rows import and land in an admin work queue
- [x] Claim flow: roll no → OTP to roster phone (MSG91; console in dev) → set password → `profiles` row, phone verified
- [x] Claim endpoint rate limiting + lockout (3 challenges/roll/h, 5 attempts/challenge, 30 min lock); generic failures, no enumeration
- [x] Role model + JWT claims; `is_admin()` helper
- [x] RLS policies written **and tested** for every table that exists so far
- [x] `cohort` derivation from `admission_year` + annual promotion job
- [x] Audit context plumbing: `set_config('app.client_ip'/'app.user_agent', …, true)` per request
- [x] Session handling + account settings page
- [x] Password recovery over SMS (custom service-role flow reusing `claim_challenges`)
- [x] `/admin` returns 404 (not a redirect) for students
- [x] `packages/notify` SMS adapter (first use)
- [ ] 👥 Arrange the Stage 5 soak: one cooperative driver, one route, ≥10 trips

**Exit criteria**
- [ ] Full claim flow works end to end with a real SMS — *works end to end **live** on the real stack with console SMS (claim → Supabase Auth user → sign-in → RLS); real SMS blocked on DLT approval + MSG91 keys*
- [x] Roster enumeration attack returns identical responses for existing and non-existing roll numbers — `auth.test.ts`: same status/shape/body for claimable, no-phone, claimed, absent; identical 429 on the 4th request (ADR-0006). timing: medians 60.9 ms real vs 61.0 ms fake (`timing.test.ts`)
- [x] RLS adversarial suite passes; policies exist on 100% of tables — `rls.test.ts` (5/5 tables) on PGlite **and real Supabase Postgres 15.8**, plus live over PostgREST (student sees own row only; roster `[]`; role PATCH 403). *favourites/push_subscriptions/notification_recipients cases land with those tables*
- [x] Junior/senior cohorts correctly derived across an academic-year boundary — `cohort.test.ts` (31 Jul → 1 Aug, Dec → Jan, idempotent promotion). *Rule itself pending TD*
- [x] `vault/modules/M04-identity.md` + `runbooks/student-cannot-claim.md` (+ ADR-0006)

**Watch for:** rows without a phone must import successfully (only *claiming* requires one). Plumb `set_config('app.client_ip', …, true)` per request or `audit_log.ip`/`user_agent` are silently NULL forever. Password recovery is a custom SMS flow — the synthetic `@students.busmitra.internal` addresses are non-routable by design.

**Files touched this stage:** `packages/db/**` (migrations 0001–0002, client, PGlite harness, tests) · `packages/contracts/src/{auth,roll,roster}.ts` · `packages/notify/**` · `apps/engine/**` · `apps/gateway/**` · `apps/web/**` · `infra/supabase/{config.toml,seed.sql}` · `docs/SCHEMA.md` · ADR-0006 · runbook — full table in M04

---

### Stage 1 — Geo core and route capture · 🟡 In progress (build done & tested; exit needs one real route driven)

**~6 days.** The mathematical heart, plus the tooling to get route data you do not currently have.
**Depends on:** Stage 0 (geo half); Stage 4 (route editor only). **Start commit:** `9cabdb2` (uncommitted tree after Stage 4) · **End commit:** —

**Build checklist** — transcribed from `docs/BUILD_PLAN.md` · 👥 = people/external task

- [x] `packages/geo`: `haversine`, `projectPointOnSegment`, `buildCumulativeDistances`
- [x] `snapToRoute` — forward-biased window + off-route detection (ARCH §5.2); widens *forwards only* after a long gap
- [x] `enforceMonotonicProgress` — **incl. global re-snap after 4 backward pings** (§5.3)
- [x] `detectCrossings` — **incl. the `skipped` rule** (§5.4), plus `finishCrossings` on explicit trip end
- [x] `computeEta` → `{p50, p90, confidence}` with the `v_hist` fallback ladder (§5.5)
- [x] `simplifyTrace` (Douglas–Peucker, iterative) + `stepTrip`, the pure reducer the engine runs
- [x] Driver PWA survey mode — 1 Hz dense capture, raw trace to Storage (`route-surveys`)
- [x] Trace → route pipeline: clean → simplify → OSRM `/match` (**chunked 80 pts, 15 overlap**) → stitch → polyline → `cumulative_dist_m` (trigger) → `lineage_id`
- [x] Admin route editor: drag-correct (vertex drag, midpoint insert, right-click delete), drop/name/alias stops, publish freezes the version, warns on a repeated stop, new version, discard draft
- [x] Simulator: N buses on real routes, σ≈8 m noise, dead zones, off-route, stalls, dup/out-of-order pings; deterministic trace replay
- [x] `packages/db` schema for `routes`, `stops`, `route_stops` (+ `buses`, `trackers`, `route_surveys`, RLS)

**Exit criteria**
- [x] `packages/geo` at >90% line coverage, including adversarial fixtures: GPS spike, backward jitter, 83 m ping gap at speed, route self-intersection — **measured: 100% lines / 97.4% branches, 83 tests**
- [ ] At least one real route surveyed, matched, corrected and published — *pipeline verified end to end against the live OSRM (matched length within 1–2% of truth, every vertex within 15 m) and through the editor in a real browser; the **survey by an actual bus** is outstanding and needs a driver*
- [x] Simulator drives 30 buses on real routes with injected noise and dead zones — 8 corridors seeded through the real pipeline; 30 buses driven for an hour (see Stage 2)
- [x] `vault/modules/M01-geo-core.md` + `ADR-0003-route-versioning.md`

**Watch for:** the global re-snap recovery after 4 sustained backward pings, and the `skipped` rule — omitting either produces a silently frozen trip, not an error. OSRM `/match` caps at 100 coordinates by default; chunk with ~15 points of overlap or raise the limit.

**Files touched this stage:** `packages/geo/**` (new) · `packages/db/migrations/0003_geography.sql`, `packages/db/src/geography.test.ts` · `packages/contracts/src/routes.ts` · `apps/engine/src/{osrm,routes}.ts`, `apps/engine/src/workers/survey.ts` · `apps/gateway/src/routes/api/admin/routes.ts` · `apps/web/app/(admin)/admin/routes/**`, `apps/web/components/admin/route-editor.tsx`, `apps/web/public/map/busmitra-dark.json`, `apps/web/app/api/map-style/route.ts` · `apps/simulator/**` · `tests/fixtures/**` — full table in M01

---

### Stage 2 — Ingestion pipeline · 🟡 In progress (build done & tested; exit needs a real phone on a cellular network)

**~5 days.** From a phone on a dashboard to a durable, replayable stream.
**Depends on:** Stage 1 geo core. **Start commit:** `9cabdb2` (uncommitted tree) · **End commit:** —

**Build checklist** — transcribed from `docs/BUILD_PLAN.md` · 👥 = people/external task

- [x] Driver tracker: `watchPosition` 5 s moving / 15 s stationary, `cadence_s` in every batch
- [x] Wake Lock, **re-acquired on every `visibilitychange` → visible**
- [x] IndexedDB ring buffer — write locally before network (20,000 pings ≈ a day)
- [x] Batch POST every 5 s; reconnect flush ≤ 500 pings with original `recorded_at`
- [x] Backoff with jitter; `navigator.onLine` + heartbeat probe
- [x] Trip UI: route picker → START → "N sent · M waiting to send" → END
- [x] `POST /v1/ingest`: HMAC over `(device_uid, ts, body)`, 5 min skew, Redis nonce cache
- [x] Zod validation; per-device rate limit (120/min, Redis); `is_backfill` when lag > 30 s
- [x] HMAC against **decrypted** `secret_enc`; 10 min rotation overlap via `secret_prev_enc`
- [x] `XADD stream:pings` then respond — no DB write
- [x] `packages/redis` key registry (with a repo scan that fails if a key is built inline)
- [x] `engine/geo.ts`: snap → monotonic progress → EWMA → `fleet:live` (backfill never overwrites newer; an ENDED trip is never resurrected)
- [x] `engine/persister.ts`: 200 rows / 2 s → COPY to a transaction-scoped staging table → `INSERT … ON CONFLICT DO NOTHING`
- [x] `positions` weekly partitions + `pg_cron`

**Exit criteria**
- [x] 30 simulated buses ingest for one hour with zero dropped or duplicated pings — **measured 2026-09-23: 19,696 fixes sent → 19,696 rows; 0 missing, 0 duplicated, 0 unexpected** (384 duplicate batches and 2% reordering injected), `benchmarks/ingest-1h-30-buses-v1.md`
- [x] Airplane-mode test: full backfill, correct ordering, `is_backfill` set, `fleet:live` unaffected — **run twice**: in the fleet run (7,771/7,771 backfill fixes flagged, 0 false positives, 0 `fleet:live` regressions across 64,260 samples) and against the real driver app in a browser with the network cut (15 buffered → all 29 rows, exactly the 10 with lag > 30 s flagged). *On a physical phone over cellular: outstanding*
- [x] Replayed batch produces no duplicate rows (unique index holds) — unit-tested, and 384 duplicated batches in the hour run produced no extra rows
- [x] Forged HMAC and stale-timestamp requests are rejected — `ingest.test.ts`: wrong secret, altered body, unknown device (answers identically), ±5 min skew, unsigned, exact replay
- [x] `vault/modules/M02-ingestion.md` + `runbooks/bus-not-appearing.md`

**Watch for:** Wake Lock is released on every visibility loss and does not return on its own — re-acquire on `visibilitychange`. `COPY` has no `ON CONFLICT`: stage into an unlogged table, then `INSERT … SELECT … ON CONFLICT DO NOTHING`.

**Files touched this stage:** `packages/redis/**` (new) · `packages/contracts/src/{tracker,signing,ingest}.ts` · `packages/db/migrations/0004_ingestion.sql`, `packages/db/src/client.ts` (COPY support) · `apps/gateway/src/plugins/device-auth.ts`, `apps/gateway/src/routes/{ingest,tracker}/**`, `apps/gateway/src/services/{trackers,trips}.ts`, `apps/gateway/src/cli/tracker.ts` · `apps/engine/src/workers/{geo,persister}.ts`, `apps/engine/src/{main.ts,lib/route-cache.ts}` · `apps/driver/**` (new) · `.github/workflows/ci.yml` (Redis service) — full table in M02

---

### Stage 3 — Live delivery · 🟢 Complete (2026-09-23)

**~5 days.** The first time this looks like a product.
**Depends on:** Stages 2 and 4. **Start commit:** `9cabdb2` (uncommitted tree after Stage 2) · **End commit:** — (uncommitted)

**Build checklist** — transcribed from `docs/BUILD_PLAN.md` · 👥 = people/external task

- [x] `GET /v1/stream` (JWT), per-connection focus, `POST /v1/stream/focus`, 15 s heartbeat
- [x] `Last-Event-ID` replay from `stream:events` — broadcast-class only (re-checked per entry; `replayTruncated`)
- [x] 3-connection cap via TTL keys refreshed by heartbeat; claim-then-count; phantom reclaim at gateway boot
- [x] `engine/presence.ts`: 5 s sweeper, LIVE→DEGRADED→DARK→ENDED at 3×/9× cadence, `signal_outages` on transitions, dead-zone classification
- [x] Student live map: MapLibre, themed, route polylines, presence-coloured *and shaped* markers, dead-reckoning interpolation, stops, bus sheet
- [x] Honest degradation UI (amber + "last seen", red + timestamp / dead zone, removal on ENDED, off-route)
- [x] Zustand fleet store fed by SSE; reconnect + visible connection indicator
- [x] `packages/ui` design tokens (both themes complete)

**Exit criteria**
- [x] 30 buses live on the map with smooth interpolation, no visible jumps — *30/30 in a real browser; largest per-frame marker move 30 px, one frame > 25 px in 50,424*
- [x] All four presence states render and transition correctly at **both** the moving and stationary cadence — a parked bus never goes amber — *DEGRADED 15.9/18.9 s, DARK 45.9/48.9 s, ENDED 649 s (targets 15/45/645) and seen in the browser; **0 false alarms** over 9,785 positions, 258 at the 15 s cadence (two runs); recovery after ENDED works*
- [x] `SIGKILL` on the gateway then restart locks nobody out of reconnecting — *1 phantom key reclaimed at boot; live again 2.6 s after restart; 1 key; no reload*
- [x] Killing the network mid-stream reconnects and replays missed events without a page reload — *25 s cut: live 0.2 s after the network returned, `Last-Event-ID` sent, 55 frames replayed, no reload*
- [x] p95 ping-to-pixel latency under 6 s, measured, not assumed — **measured: 4.03 s** (p50 3.02 s, n = 4,604, 30 buses); re-run 4.03 s (n = 470, none > 10 s)
- [x] `vault/modules/M03-live-delivery.md` + `ADR-0001` (formalise the SSE decision) + `runbooks/live-map-not-updating.md`

**Watch for:** thresholds are 3× and 9× the reported cadence, never absolute seconds. Only broadcast-class events are replayable from `stream:events`.

**Files touched this stage:** `packages/db/migrations/0005_live_delivery.sql` (+ `live.test.ts`) · `packages/contracts/src/{sse,tracker}.ts` · `packages/redis/src/{keys,fleet,streams,events}.ts` · `packages/ui/**` (new) · `apps/engine/src/workers/{geo,presence,stop-events}.ts`, `lib/rehydrate.ts`, `main.ts` · `apps/gateway/src/routes/stream/**`, `routes/api/network.ts`, `{app,server,testing}.ts`, `services/jwt.ts` · `apps/driver/src/tracker/sampler.ts` · `apps/simulator/src/{model,presence-watch,cli}.ts` · `apps/web/{lib/sse,lib/store,lib/map,components/map,components/live}/**`, `app/(student)/*`, `app/globals.css` · `tests/e2e/{cdp,live-map,resilience}.ts` · `docs/ARCHITECTURE.md`, `docs/SCHEMA.md` · ADR-0001 · runbook — full table in M03

---

### Stage 5 — Stops, search and personal ETA · 🟡 Built (open: stopwatch walk, **ETA soak gate — blocks Stage 6**)

**~6 days + a real-bus soak.** Where the app becomes useful rather than merely impressive.
**Depends on:** Stage 3. Runs parallel with Stage 7. **Start commit:** `9cabdb2` (uncommitted tree after Stage 3) · **End commit:** —

**Build checklist** — transcribed from `docs/BUILD_PLAN.md` · 👥 = people/external task

- [x] Stop search: pg_trgm (+ `fold_place` phonetic key) → Photon fallback (< 0.4) → `ST_DWithin` 2 km → rank → per-stop serving buses; Redis 5 min cache (of the matching; buses joined fresh)
- [x] Result rendering: running / scheduled / not running today (+ already passed)
- [x] Location pinning (drag / use my location), coarsened ~100 m by a DB trigger, travel mode
- [x] Walking ETA via OSRM foot → `walk_eta_cache` (bicycle, motorbike, car too; DB empties it on pin/mode change)
- [x] `engine/eta.ts`: §5.5 blend + fallback ladder → `trip:{id}:eta`, `eta.update` on > 30 s change (pub/sub, per-user, never replayed)
- [x] Leave-now evaluator (10 s ticker, `subs_active`) — emits event only (`stream:notify`)
- [x] Trip subscription lifecycle + vertical route timeline
- [x] Nightly `segment_speeds` job (incremental, four rungs, idempotent, 14-day catch-up) on `pg_cron`
- [x] Predicted-vs-actual instrumentation per stop (`eta_predictions`, `pnpm sim eta-report`)

**Exit criteria**
- [x] Fuzzy search returns correct stops for 20 hand-written misspellings — *20/20 first-place, `search.test.ts`; plus a look-alike test ("kothi" → Koti, not Kondapur)*
- [x] Area search ("Dilsukhnagar") returns all stops within 2 km with serving buses — *exactly the PostGIS truth set, each with its buses; unserved stop excluded; geocoder fallback for a non-stop locality*
- [ ] Walking ETA within 20% of a stopwatch-timed real walk — *needs a person to walk it; the stop page shows the number to compare*
- [ ] **Soak gate:** bus ETA MAE < 90 s at a 10-minute horizon over ≥10 real trips — **measured: ___** *(may complete during Stage 7; **blocks the start of Stage 6**). Simulated baseline, not the gate: 146 s (n = 34, 30 trips, cold start), see the benchmark*
- [x] `vault/modules/M05-search-eta.md` + `benchmarks/eta-accuracy-v1.md` *(v1 holds the simulated baseline; the real soak is v2)*

**Watch for:** the leave-now evaluator **emits the event only** — Stage 6 delivers it. With ~2 trips a day only the coarse `segment_speeds` rungs will have samples; an MAE against a cold-start blend is the honest baseline.

**Files touched this stage:** `packages/db/migrations/0006_search_eta.sql` (+ `search-eta.test.ts`) · `packages/contracts/src/search.ts` · `packages/redis/src/keys.ts` · `apps/engine/src/workers/{eta,leave-now,stop-events}.ts`, `lib/speed-model.ts`, `walk.ts`, `osrm.ts`, `routes.ts` · `apps/gateway/src/services/{search,geocoder}.ts`, `routes/api/{search,me}.ts`, `routes/stream/index.ts` · `apps/simulator/src/eta-report.ts` · `apps/web/app/(student)/{search,stop/[id],settings}`, `components/{eta,search,settings,live}/**`, `lib/store/**` · `tests/e2e/stage5.ts` · `docs/ARCHITECTURE.md` §5.5–5.6, `docs/SCHEMA.md` — full table in M05

---

### Stage 7 — Admin console · 🟡 Built (all code exits met, browser-tested; open: a TD usability session)

**~6 days.** The Transport Department's half of the product. Build while the Stage 5 soak accumulates.
**Depends on:** Stage 3 (and Stage 4 auth). **Start commit:** `9cabdb2` (uncommitted tree after Stages 3 + 5) · **End commit:** —

**Build checklist** — transcribed from `docs/BUILD_PLAN.md` · 👥 = people/external task

- [x] Fleet management: bus CRUD (archive), tracker pairing (QR, one-time link) + secret rotation + unpair, driver + route assignment
- [x] Out of commission → ticket → T0 (typed count); resolve → T2 on the same ticket, bus back to active — *delivery is Stage 6: the row is committed and `stream:notify` rung (ADR-0007)*
- [x] Announcements: composer, tier explainer, audience selector (incl. Custom → `announcement_recipients`), live count, schedule (+ cancel), count-stating confirmation **enforced by the gateway**
- [x] Event-day CSV: parse → validate against fleet + published routes → rendered diff → confirm → apply → cohort T2 doorbell; `content_hash` flags an identical file and an unchanged apply notifies nobody
- [x] Ticket queue with timeline + assignment; auto-opened signal-loss tickets (engine, self-resolving)
- [x] Live fleet dashboard (presence, last ping + cadence, trip, today's 10-min ETA MAE, open tickets)
- [x] Audit log viewer with before/after

**Exit criteria**
- [ ] 👥 A non-technical TD member completes all three core workflows unassisted in a usability session — *the three workflows run end to end in headless Chrome (`tests/e2e/stage7.ts`, 2026-09-24, no page errors); the session itself needs a TD member*
- [x] Malformed CSV is rejected at preview with per-row, per-column errors and sends nothing — `console.test.ts` + browser: line 3 `departure_time` and `cohort` errors, 0 rows written, 0 doorbells
- [x] Identical CSV re-upload does not re-notify — preview names the identical earlier upload, `notify_count` 0, apply rings nothing (test + browser)
- [x] Every admin mutation appears in `audit_log` with correct before/after — `console.test.ts` covers buses, drivers, trackers, tickets, ticket_events, announcements, announcement_recipients, roster_uploads, event_day_buses, all with the admin as actor; secrets never logged
- [x] `vault/modules/M07-admin-console.md` + `runbooks/csv-upload-failed.md` (+ ADR-0007)

**Watch for:** nothing reaches phones without a rendered preview, a resolved recipient count and an explicit confirmation. A *Custom* audience needs `announcement_recipients` — `audience_ref` is a single uuid.

**Files touched this stage:** `packages/db/migrations/0007_admin_console.sql` (+ `admin.test.ts`) · `packages/contracts/src/{admin,notify}.ts`, `routes.ts` · `packages/redis/src/events.ts` · `apps/engine/src/lib/{audience,ticker}.ts`, `workers/{event-day,schedule,tickets,announcements}.ts`, `main.ts` · `apps/gateway/src/routes/api/admin/{common,fleet,tickets,announcements,event-day,audit,dashboard}.ts`, `roster.ts`, `routes.ts`, `app.ts`, `services/trackers.ts`, `plugins/device-auth.ts` · `apps/web/app/(admin)/admin/**`, `components/admin/{confirm-send,types}`, `lib/admin.ts` · `tests/e2e/stage7.ts` · `docs/SCHEMA.md`, `docs/ARCHITECTURE.md` · ADR-0007 · runbook — full table in M07

---

### Stage 6 — Notification spine · 🟡 Built (every code exit met; open: iPhone 👥, phone-buzz latency 👥, real SMS (DLT), Stage 5 soak gate)

**~7 days. The largest, highest-risk stage.** Everything the product promises is delivered here.
**Depends on:** Stage 5 **including its MAE gate**; Stage 7; DLT registration. **Start commit:** `9cabdb2` (uncommitted tree after Stage 7) · **End commit:** —

> ⚠️ Built on 2026-09-24 **before** the Stage 5 MAE gate, on the owner's instruction. Read_this_first §2 says not to; the code is complete and tested against simulated and recorded data, but the stage must not be marked complete — and leave-now alerts must not be switched on for real students — until the real-bus soak shows MAE < 90 s.

**Build checklist** — transcribed from `docs/BUILD_PLAN.md` · 👥 = people/external task

- [x] VAPID keys (`pnpm --filter @busmitra/notify vapid`); SW `push` + `notificationclick` (`public/sw.js`), manifest + icons
- [x] Subscription lifecycle + health; `410` pruning (404/410 delete, 429 back-off, ≥ 5 failures unhealthy)
- [x] iOS install-prompt UX (Share → Add to Home Screen; SMS meanwhile) — *not yet seen on an iPhone*
- [x] MSG91 SMS adapter with delivery receipts (T0/T1 templates, request id, token-guarded webhook)
- [x] `engine/notify.ts`: tier → audience → filters → dedupe → channel → send → receipt
- [x] Synchronous SMS fallback on push POST status
- [x] Parent + recipients in one transaction; `dedupe_key` guard (+ `source_key` on the parent); collapse tags
- [x] Event wiring table (trip start T1/T3, stop reached, leave now, signal lost T2/T4, out of commission T0) + back in service T2, announcements, event-day lists
- [x] Notification actions: *Follow*, *Not today*
- [x] Notification center (tier filter, unread, ticket cards, T0 ack)
- [x] Kill switch, per-bus mute, quiet hours, min-tier (`max_tier`), T0 breakthrough

**Exit criteria**
- [x] Restart the notify worker mid-fan-out → zero duplicates — *80 + 6 students, killed after 30 sends, restarted: 0 duplicates, 86/86 center rows (`notify.test.ts`)*
- [x] Flap a geofence boundary 20 times → one arrival notification — *20 alternating arrived/departed frames → 1 notification, 1 push*
- [x] Bus passes a stop unconfirmed → `skipped` fires and every subsequent stop still notifies — *skipped 2, arrived 3, 4 → all notify, one collapse tag*
- [x] Replay a full day of backfilled pings → zero retroactive alerts — *backfill frames + hours-old crossings + an old signal loss → 0 notifications, 0 pushes*
- [x] 600 users, one T0 announcement → all delivered within 30 s — **0.55 s** on Postgres 15 (0.31 s PGlite) with a 20 ms push stub; *at real FCM latency ≈ 6 s estimated — Stage 8 k6 measures it*
- [x] Revoke push permission mid-session → T1 falls back to SMS, notification center still written — *push 410 → subscription pruned, SMS sent at once, center row `sms`*
- [x] Kill switch active → T3 suppressed, T0 breaks through
- [ ] 👥 iOS: installed PWA receives push; uninstalled iOS receives SMS for T0/T1 — *needs an iPhone (and DLT for the SMS half); the install UX and SMS routing are built and tested*
- [ ] 👥 End-to-end alert latency (event → phone buzzes) p95 under 10 s — **measured to the browser: p95 2.4 s, p50 590 ms** (n = 40, real FCM, headless Chrome); *the phone's share needs a physical phone*
- [x] Notification center is written even when every transport fails — *push 500 + SMS failing: center row `inapp_only` with both reasons*
- [x] `vault/modules/M06-notifications.md` + `ADR-0004-tiering-and-dedupe.md` + `runbooks/push-not-delivering.md` (+ `benchmarks/alert-latency-v1.md`)

**Watch for:** SMS falls back on the push POST's HTTP status, **synchronously** — there is no delivery receipt to wait for. Parent `notifications` row and all `notification_recipients` rows in one transaction.

**Files touched this stage:** `packages/db/migrations/0008_notifications.sql` (+ `notifications.test.ts`) · `packages/notify/src/{tiers,push,sms,cli/vapid}.ts` · `packages/config/src/env.ts`, `.env.example` · `packages/contracts/src/notify.ts` · `packages/redis/src/keys.ts` · `apps/engine/src/lib/{notify-plans,audience}.ts`, `workers/notify.ts`, `main.ts` · `apps/gateway/src/routes/api/notifications.ts`, `routes/stream/index.ts`, `routes/tracker/index.ts`, `routes/api/admin/announcements.ts`, `{app,server,testing}.ts` · `apps/web/public/{sw.js,icons}`, `app/manifest.ts`, `lib/{push,store/inbox}.ts`, `components/notifications/**`, `app/(student)/{notifications,layout,page,settings}` · `tests/e2e/stage6.ts` · `docs/SCHEMA.md`, `docs/ARCHITECTURE.md` · ADR-0004 · runbook · benchmark — full table in M06

---

### Stage 8 — Learning, observability and load · 🔵 Built and measured (open: the dead-zone soak on real routes)

**~5 days of build + a ~2-week observation window that runs in parallel.**
**Depends on:** Stage 6. **Start commit:** `9cabdb2` (uncommitted tree after Stage 6; file hashes snapshotted 2026-09-24 06:53) · **End commit:** — (the commit on top of `09c10b4`)

**Build checklist** — transcribed from `docs/BUILD_PLAN.md` · 👥 = people/external task

- [x] `engine/deadzone.ts`: nightly DBSCAN (ε 150 m, minPts 4, ≥ 2 trips) → `dead_zones` (update in place, retire, never delete); sweeper consumes (ignores retired); admin overlay + rename on `/admin/health`
- [x] OpenTelemetry end to end (`packages/telemetry`; one trace ingest → geo → fan-out / ETA / notify; traceparent in a `tp` stream field) → OTLP (local Grafana stack; Grafana Cloud config); Sentry on both web apps (no PII, zero bytes without a DSN)
- [x] Dashboards (`infra/grafana/dashboards/busmitra-overview.json`: latency, MAE by route and hour, delivery by channel, dead zones, SSE connections, consumer lag)
- [x] Alerting rules (5, `infra/grafana/provisioning/alerting`), mirrored by the console's Health page; a test keeps the thresholds in step
- [x] k6: 600 SSE + 30 ingest + T0 broadcast; 1,000 headroom (`pnpm sim load`, `tests/load/sse.js`)
- [x] Five chaos drills, each with a runbook (`pnpm sim chaos …`)
- [ ] *(optional)* on-bus auto-detect prompt — not built (optional)

**Exit criteria**
- [x] DBSCAN clustering verified against simulator-injected dead zones — **8/8 learnable zones found, 0 false** (5 seeds × 12 trips; `apps/simulator/src/deadzone.test.ts`)
- [ ] **Soak gate:** ≥3 dead zones learned and classified correctly on real routes *(completes during Stage 9's pilot)*
- [x] 600-client k6 run: p95 < 6 s, zero dropped notifications, zero stream lag growth — **measured: p95 4.04 s; T0 600/600 center, 600/600 SSE, 600/600 push (last 6.4 s), 0 duplicates; lag max 4, 0 → 0**
- [x] 1,000-client headroom run degrades gracefully — **p95 4.07 s, 1,000/1,000 streams, T0 1,000/1,000 (last push 9.7 s), 0 duplicates, lag flat**
- [x] All five chaos drills executed with a written, tested runbook each — Redis 33 s (0 lost), Postgres 71 s (live map unaffected, 0 lost — **after fixing a crash it exposed**), worker SIGKILL mid-T0 (0 duplicates, ≤ 64 in flight — **after fixing a 1,000-row claim**), OSRM flooded (stop page p50 717 ms, all 200), VAPID revoked (50/50 → SMS, alert fired)
- [x] `vault/modules/M08-observability.md` + `benchmarks/load-300-v1.md` (+ ADR-0009)

**Watch for:** if the TD's ridership figures came back materially different in Stage 0, load-test against those, not against 600/1,000.

**Files touched this stage:** `packages/geo/src/cluster.ts` · `packages/telemetry/**` · `packages/db/migrations/0009_observability.sql`, `src/client.ts` · `packages/redis/src/{streams,events}.ts` · `packages/config/src/{thresholds,env}.ts` · `apps/engine/src/{main.ts,workers/{deadzone,notify,geo,eta,presence,tickets}.ts,lib/health.ts,cli/deadzone.ts}` · `apps/gateway/src/{app,server}.ts, plugins/otel.ts, routes/{ingest,stream,tracker}/*, routes/api/admin/observability.ts` · `apps/web/app/(admin)/admin/health`, `components/admin/dead-zone-map.tsx`, `lib/sentry.ts`, `instrumentation*.ts` · `apps/driver/src/lib/sentry.ts` · `apps/simulator/src/{deadzone.ts,load/*,run.ts,cli.ts}` · `tests/load/*` · `infra/grafana/**` · docs · ADR-0009 · runbooks — full table in M08

---

### Stage 9 — Production and hardware · 🟡 Built and proven locally (open: provisioning, pilot, physical tracker — all 👥)

**~5 days plus hardware lead time.**
**Depends on:** Stage 8. **Start commit:** as Stage 8 (built in the same session) · **End commit:** —

**Build checklist** — transcribed from `docs/BUILD_PLAN.md` · 👥 = people/external task

- [ ] 👥 Provision production (Supabase Pro Mumbai, Fly.io `bom`, Redis, OSRM VPS, Cloudflare) — *everything is written as config (`infra/fly`, `infra/prod/geo`, `apps/web/vercel.json`, `apps/driver/public/_headers`) and the images build and run in production mode; the accounts and money are the owner's*
- [x] Migration + rollback runbooks; daily backups with tested restore — `deploy.md`, `rollback.md`, `backup.sh` + nightly workflow, `restore-drill.sh`: **31 tables, 90,316 rows, everything matches, 6 s** (plain and encrypted)
- [x] Domain, TLS, HTTP/2, CSP, security headers — nonce CSP (0 violations in a browser on a production build), HSTS, gateway headers; TLS/HTTP/2 at Fly/Cloudflare; *the domain itself is the owner's*
- [x] Hardware tracker adapter emitting identical `PingBatch` — `apps/adapter` (GT06, ADR-0008), 17 tests incl. the manual's packets and an end-to-end run through the real gateway
- [x] Staged rollout 3 → 10 → 30 — written as a procedure with entry criteria (`deploy.md` §5); *doing it needs buses* 👥
- [x] Driver sheet, TD handbook, student guide, campus-IT handover (`docs/handover/`)

**Exit criteria**
- [ ] Production deployed, monitored, backed up, **restore tested** — *restore tested locally and repeatable against production; deploying needs accounts* 👥
- [ ] Two-week pilot with ETA MAE < 90 s on real routes — **measured: ___** 👥
- [ ] Hardware adapter validated against one physical tracker — *validated against a byte-exact software GT06* 👥
- [x] Handover pack complete — four documents; Telugu/Hindi need native review 👥
- [x] `vault/modules/M09-production.md` + `runbooks/deploy.md` + `runbooks/rollback.md` (+ ADR-0008, ADR-0010 proposed)

**Watch for:** staged rollout is 3 buses → two weeks of measurement → 10 → full 30. ETA accuracy is proven before any fleet-wide hardware spend.

**Files touched this stage:** `apps/adapter/**` · `infra/docker/Dockerfile.node`, `.dockerignore`, `infra/fly/*`, `infra/prod/geo/*`, `infra/scripts/{backup,restore-drill}.sh`, `.github/workflows/{backup,deploy}.yml` · `apps/web/{lib/csp.ts,middleware.ts,next.config.ts,app/layout.tsx,lib/push*.ts,public/{sw.js,offline.html},vercel.json}` · `apps/gateway/src/plugins/security.ts`, `cli/tracker.ts` · `packages/contracts/src/{notify,ingest}.ts` · `apps/driver/src/i18n.ts`, `App.tsx`, `public/_headers` · `docs/handover/*` · `tests/e2e/stage9-csp.ts` · ADR-0008, ADR-0010 · runbooks — full table in M09

---

## 4. Carried forward

Work inherited from a completed stage, and out-of-scope findings parked for the stage that owns them. Move items here the moment they are found; clear them when they land.

| Found in | For stage | Item | Status |
|---|---|---|---|
| Stage 0 (2026-09-22) | Stage 0 exit | Install Docker + osmium; run prepare scripts + `pnpm dev`; record smoke + sizes in M00 | ✅ done 2026-09-22 |
| Stage 0 (2026-09-22) | Stage 0 exit | Commit + push to GitHub; confirm both `ci` jobs green; record run URL in M00 | ✅ done — owner pushed `09c10b4`; both jobs green: https://github.com/KarlapatiNandu/ETA/actions/runs/36020689835 |
| Stage 0 (2026-09-22) | 0 | Publish OSRM + tile artefacts as a GitHub release (needs a pushed commit) | open |
| Stage 0 (2026-09-22) | 5 | Photon India index (0.56 GB) up; sample search | ✅ done — `q=Dilsukhnagar` → bus stop on Vijayawada Highway |
| Stage 0 (2026-09-22) | 3 | Map must show visible "© OpenMapTiles © OpenStreetMap contributors" credit (CC-BY tiles) | ✅ done — attribution control + style source |
| Stage 4 (2026-09-22) | Stage 4 exit | Real-SMS claim once DLT OTP template approved + MSG91 keys | open — blocked on DLT |
| Stage 4 (2026-09-22) | 9 | Production Supabase dashboard must mirror config.toml: sign-up off, **email provider on**, min password 8, token hook, private `roster-uploads` bucket | 🟡 written into `vault/runbooks/deploy.md` §4; doing it needs the production project 👥 |
| Stage 4 (2026-09-22) | Stage 4 exit | DB suites on real Supabase PG 15 | ✅ done — 45/45 locally; CI job `postgres15` added |
| Stage 4 (2026-09-22) | 4 | Statistical timing test for claim start (real vs fake roll) | ✅ done — medians 60.9 vs 61.0 ms |
| Stage 4 (2026-09-22) | 2 | Rate-limit store → Redis via `packages/redis/keys.ts`; roster job → BullMQ | 🟡 Redis store done (namespace from `keys.ts`); BullMQ still open |
| Stage 1 (2026-09-23) | Stage 1 exit | Survey one **real** route with the driver app, match it, correct it, publish it — needs a driver and ~45 min of driving | open — arrange with the Stage 5 soak driver |
| Stage 1 (2026-09-23) | 3 | Wire `stepTrip`'s crossing events to `trip_stop_events` and the `stop.reached` SSE frame (computed and tested already) | ✅ done — `stop-events` consumer group |
| Stage 1 (2026-09-23) | 3 | Extend `apps/web/public/map/busmitra-dark.json` for the student map; keep the OpenMapTiles/OSM credit visible | ✅ done |
| Stage 1 (2026-09-23) | 3 / 7 | Light theme: the admin shell shows a light canvas with dark panels under `prefers-color-scheme: light` — fix with `packages/ui` | ✅ admin shell checked in the browser (Stage 7): clean light canvas and panels; the route editor's map stays dark-first by design |
| Stage 1 (2026-09-23) | 7 | Stop management (rename, merge, archive) and a guard against moving a stop a published route depends on | ✅ rename / aliases / area / landmark / archive + the guard (Stage 7); **merge** still open |
| Stage 1 (2026-09-23) | 7 | Tracker pairing is a CLI (`pnpm tracker provision`); the console needs a pairing screen with a QR code | ✅ done — Fleet → bus → Pair a phone (QR shown once), rotate, unpair |
| Stage 2 (2026-09-23) | Stage 2 exit | Airplane-mode test on a **physical phone** over cellular (done in a browser with the network cut, and in the simulator) | open — needs a phone and a driver |
| Stage 2 (2026-09-23) | 3 | Rehydrate `fleet:live` from the last 5 minutes of `positions` on engine boot (ADR-0002) | ✅ done — `lib/rehydrate.ts`, presence judged by age |
| Stage 2 (2026-09-23) | 3 / 8 | `stream:pings:dead` has nothing watching it — surface a non-zero length on the observability page / as an alert | ✅ done (Stage 8) — Health page + alert *Pings the persister could not write* |
| Stage 2 (2026-09-23) | 5 | Schedule `drop_expired_positions_partitions` once nightly `segment_speeds` aggregation exists; add the student RLS policy on `positions` | ✅ done — migration 0006 |
| Stage 2 (2026-09-23) | 9 | The driver app is English-only; translate before the pilot (few strings) — moved from 6 to 9, where the pilot is, with the student notification copy | 🟡 driver app translated (Telugu, Hindi — draft, needs native review 👥); student notification copy still English (needs a language preference) |
| Stage 2 (2026-09-23) | 9 | Driver bundle 254 kB (77 kB gz), mostly React — `preact/compat` is the lever if first load hurts | open — 264 kB (80 kB gz) with three languages; not needed yet |
| Stage 4 (2026-09-22) | 5, 6 | Add A-vs-B RLS cases for `favourites`, `push_subscriptions`, `notification_recipients` when created | ✅ done — all three (Stages 7 and 6) |
| Stage 4 (2026-09-22) | 7 | Explicit roster-removal action (uploads never delete) | ✅ done — `DELETE /v1/admin/roster/students/:roll` (unclaimed only; audited) |
| Stage 4 (2026-09-22) | 8 | Drizzle schema + migration-drift check in CI; Playwright e2e for claim → login | open — no Drizzle in this repo; re-scoped to a SCHEMA.md ↔ schema drift check, and a browser e2e for claim → login |
| Stage 3 (2026-09-23) | 6 | Deliver T2 "signal lost" / T4 "known dead zone" from `bus.status` reasons; never from `stop.reached.backfill` | ✅ done (Stage 6) |
| Stage 3 (2026-09-23) | 7 | Auto-open a signal-loss ticket when a `signal_outages` row stays open 5 min | ✅ done — `engine/workers/tickets.ts` (running/dark trips only; self-resolving) |
| Stage 3 (2026-09-23) | 7 | After a secret rotation the gateway can refuse the new secret for up to 60 s (decrypted-secret cache): refresh the directory on rotation, or re-read once on a signature miss | ✅ done — both: the rotating instance forgets at once; others re-read on a miss (≤ 1 query / 5 s / device) |
| Stage 3 (2026-09-23) | 8 | Dead-zone learning fills `dead_zones`; admin overlay; `stop-events` / `eta` consumer lag on the observability page | ✅ done (Stage 8) — nightly learner, Health-page map + rename, lag for every group |
| Stage 3 (2026-09-23) | 9 | HTTP/2 at the edge (several tabs × SSE on HTTP/1.1 meets the 6-connection limit) | ✅ configured (Stage 9) — Fly edge + Cloudflare; takes effect on deploy |
| Stage 5 (2026-09-23) | Stage 5 exit | **ETA soak:** ≥10 real trips on one route with the driver app, then `pnpm sim eta-report --since <start>`; tune §5.5 weights on it | open — needs the soak driver |
| Stage 5 (2026-09-23) | Stage 5 exit | Stopwatch-timed walk from a pinned home vs the stop page's walking time (≤ 20 %) | open — needs a person |
| Stage 5 (2026-09-23) | 6 | Consume `stream:notify` `leave_now` → T1; favourites; "I'm on the bus" → subscription `boarded` | ✅ done (Stage 6) |
| Stage 5 (2026-09-23) | 7 | Create `scheduled` trips with `scheduled_start_at` (timetable / event-day CSV) so "scheduled · 07:40" appears; timetable offsets cannot live in a published route's `route_stops` (frozen) | 🟡 event-day lists done (`engine/workers/schedule.ts`, next departure per bus, service day only); a regular **timetable** has no table yet — open |
| Stage 5 (2026-09-23) | 8 | ETA-accuracy dashboard from `eta_predictions` (MAE per horizon per route) | ✅ done (Stage 8) — `obs_eta_accuracy`, Grafana panels, Health page |
| Stage 7 (2026-09-24) | Stage 7 exit | Usability session: a non-technical TD member does out of commission, an announcement to one cohort and an event-day list unassisted | open — needs a TD member 👥 |
| Stage 7 (2026-09-24) | 6 | Deliver the `stream:notify` doorbells: `announcement`, `ticket` opened (T0) / resolved (T2, same audience), `event_day` (T2, `diff_summary.notify_cohorts`); set `announcements.notification_id` + its FK in 0008 | ✅ done (Stage 6) |
| Stage 7 (2026-09-24) | 6 | **Sweep for rows published but never delivered** (ADR-0007): announcements, commission tickets, applied event-day uploads, and leave-now subscriptions with `notified_departure_at` but no notification; ignore stale doorbells on a new consumer group | ✅ done — `recoverLost` every 30 s; freshness rules per event (M06) |
| Stage 7 (2026-09-24) | 6 | Starring UI (favourites table exists); `ticket.update` SSE frames for the ticket card; announcement attachments | 🟡 starring UI + `ticket.update` done (Stage 6); **attachments** still open |
| Stage 7 (2026-09-24) | 3 / 8 | A `signal_outages` row stays open (NULL `duration_s`) when its trip ends while DARK — close it on trip end; dead-zone learning reads it | ✅ done (Stage 8) — trigger `trips_close_outages` (0009); the learner ignores such rows |
| Stage 7 (2026-09-24) | later | Stop merge; driver shift-assignment check on ingest (ARCH §10) | open |
| Stage 6 (2026-09-24) | Stage 6 exit | iOS: installed PWA receives push; uninstalled iPhone gets SMS for T0/T1 | open — needs an iPhone 👥 (+ DLT) |
| Stage 6 (2026-09-24) | Stage 6 exit | Event → **phone** buzzes p95 < 10 s on a physical phone over cellular (browser: 2.4 s) | open — needs a phone 👥 |
| Stage 6 (2026-09-24) | Stage 6 exit | Real SMS: DLT approval, `MSG91_TEMPLATE_T0/T1`, receipt webhook URL in MSG91 | open — blocked on DLT |
| Stage 6 (2026-09-24) | 8 | 600-client run with a real (or realistic) push latency; log the engine's POST time per notification (alert-latency v2); `notify` consumer lag + push-failure-rate alert | ✅ done (Stage 8) — FCM-shaped sink; push POST time recorded (`busmitra.notify.push_post`); lag + push-failure alerts |
| Stage 6 (2026-09-24) | 9 | Serwist offline shell (sw.js does push only); production VAPID pair generated once, stored as secrets | ✅ done (Stage 9) — a plain offline page (no cached live data); VAPID generation in deploy.md |
| Stage 8 (2026-09-24) | Stage 8 exit | **Dead-zone soak:** ≥ 3 zones learned and classified on real routes | open — during the Stage 9 pilot 👥 |
| Stage 8 (2026-09-24) | 9 | Grafana Cloud stack: OTLP env, import the dashboard, alert rules with `BUSMITRA_PROM_UID=grafanacloud-prom`, alert routing to a phone | open — needs the account 👥 |
| Stage 8 (2026-09-24) | 9 | Load v2 on production infrastructure with focus scoping and real FCM; consider an 8 s push timeout (1 % of FCM's tail exceeds 5 s) | open |
| Stage 8 (2026-09-24) | later | *(optional)* on-bus auto-detect prompt (ARCH §6.5) | open |
| Stage 9 (2026-09-24) | Stage 9 exit | Provision production + first deploy (deploy.md §4), then the restore drill on the first production backup | open — owner's accounts 👥 |
| Stage 9 (2026-09-24) | Stage 9 exit | Pilot: 3 buses × 2 weeks, MAE < 90 s; then 10, then 30 | open — needs buses 👥 |
| Stage 9 (2026-09-24) | Stage 9 exit | A physical GT06 (or the device the TD chooses → a decoder for it) through the adapter | open — needs a device 👥 |
| Stage 9 (2026-09-24) | 9 | Decide ADR-0010 (route data under ODbL) before the public launch | open — owner 👥 |
| Stage 9 (2026-09-24) | later | Student notification copy in Telugu/Hindi (a per-student language preference) | open |
| Stage 8 (2026-09-24) | environment | The repository lives in an iCloud-synced `~/Desktop`: after a long sleep iCloud recreated the tree with 255 "… 2" conflict copies (cleaned; `.gitignore` refuses them). Move the repo out of `Desktop` | open — owner's call |

---

## 5. Blockers

| Date | Stage | Blocker | Blocks | Owner | Resolved |
|---|---|---|---|---|---|
| — | — | _(none)_ | — | — | — |

---

## 6. Vault index mirror

Ticked as each artefact is written. The authoritative index is `vault/README.md`.

| Type | Artefact | Written |
|---|---|---|
| Module | M00 … M09 | 8 of 10 drafted (M03 complete; M00, M04, M01, M02, M05, M07, M06 in-progress) |
| ADR | ADR-0001 SSE over WebSocket (Stage 3) | ✅ |
| ADR | ADR-0002 Redis live / Postgres record (drafted in ARCH §2.4) | ⬜ |
| ADR | ADR-0003 route versioning (Stage 1) | ✅ |
| ADR | ADR-0004 tiering and dedupe (Stage 6) | ✅ |
| ADR | ADR-0005 self-hosted tiles (drafted in ARCH §2.3) | ⬜ |
| Runbook | `bus-not-appearing.md` (Stage 2) | ✅ |
| Runbook | `student-cannot-claim.md` (Stage 4) | ✅ |
| ADR | ADR-0006 uniform claim responses (Stage 4) | ✅ |
| ADR | ADR-0007 confirmed sends and doorbells (Stage 7) | ✅ |
| Runbook | `csv-upload-failed.md` (Stage 7) | ✅ |
| Runbook | `push-not-delivering.md` (Stage 6) | ✅ |
| Runbook | 5 × chaos drill runbooks (Stage 8): `map-reconnecting-redis-down`, `history-and-console-down-postgres`, `alerts-late-or-missing`, `etas-wide-or-walking-times-missing`, `push-not-delivering` §6 | ✅ |
| Runbook | `deploy.md`, `rollback.md` (Stage 9) | ✅ |
| ADR | ADR-0008 GT06 hardware adapter (Stage 9) · ADR-0009 observability and load (Stage 8) · ADR-0010 route data licence (proposed) | ✅ |
| Benchmark | `ingest-1h-30-buses-v1.md` (Stage 2) | ✅ |
| Runbook | `live-map-not-updating.md` (Stage 3) | ✅ |
| Benchmark | `eta-accuracy-v1.md` (Stage 5) | ✅ simulated baseline; real soak → v2 |
| Benchmark | `alert-latency-v1.md` (Stage 6) | ✅ |
| Benchmark | `load-300-v1.md` (Stage 8) — 600 + 1,000 students | ✅ |
