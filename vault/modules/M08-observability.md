---
stage: M08
title: Learning, observability and load
status: in-progress
started: 2026-09-24
completed: —
---

# M08 — Learning, observability and load

## Summary

The system now learns where the network fails and explains those places instead of alarming
about them; it can be watched end to end (one trace per GPS fix, dashboards, five alert rules,
and a health page in the TD console); and it has been measured under load and under failure.
600 students and a 1,000-student headroom run both held p95 fix → frame at **4.0–4.1 s** with
zero dropped or duplicated notifications and no consumer-lag growth. All five chaos drills ran
against real processes and containers — and two of them found real bugs that are now fixed: a
Postgres restart used to crash the gateway and the engine, and a worker killed mid-fan-out could
lose most of a broadcast's buzzes.

Open, and not code: the **soak gate** (≥ 3 dead zones learned on real routes) needs real buses
running for about two weeks, which is Stage 9's pilot.

## Scope delivered

- [x] `engine/workers/deadzone.ts`: nightly (02:30 IST) DBSCAN, ε 150 m, minPts 4, ≥ 2 trips,
      60 m buffered hulls → `dead_zones`; update in place, retire (never delete); the presence
      sweeper already classifies with it (now ignoring retired zones); `pnpm --filter
      @busmitra/engine deadzone` runs it on demand
- [x] Admin overlay: the console's **Health** page maps the learned zones; an admin can rename
      one (audited) and the name survives every later run
- [x] OpenTelemetry end to end (`packages/telemetry`): one trace per fix through both processes
      and across Redis streams; metrics for latency, connections, lag, dead letters, fleet state,
      push time and send outcomes; OTLP to the local Grafana stack or Grafana Cloud
- [x] Sentry on the web app and the driver app — errors only, no personal data, and not a byte
      downloaded unless a DSN is configured
- [x] Dashboard `infra/grafana/dashboards/busmitra-overview.json` (19 panels: fix → frame p50/p95,
      connections, lag, fleet, ingest, notify latency, push time, send outcomes, delivery by
      channel, ETA MAE by route and hour, outages per day, learned zones)
- [x] Alerting rules (`infra/grafana/provisioning/alerting/busmitra.yaml`): p95 > 8 s for 5 min,
      lag > 1,000, push refusals > 10 %/h, a bus silent 15+ min, any dead letter — the same
      rules computed by `/v1/admin/observability` for the console
- [x] k6 load test (`tests/load/sse.js`, k6 + xk6-sse built in Docker) driven by `pnpm sim load`:
      600 SSE + 30 ingest streams + a T0 broadcast; 1,000-client headroom
- [x] Five chaos drills (`pnpm sim chaos redis|postgres|worker|osrm|vapid`), each with a runbook
- [x] Carried in and done: `stream:pings:dead` surfaced (Health page + alert); outages closed
      when their trip ends; ETA-accuracy view per route and hour; notify consumer lag and push
      failure alerting; the engine's push POST time recorded per send (alert-latency v2 input)

**Deliberately not done, and why:**
- *(optional)* the on-bus auto-detect prompt (ARCH §6.5) — optional in the plan; carried forward.
- A Drizzle schema + migration-drift check (carried from Stage 4): the project has no Drizzle —
  migrations are SQL and SCHEMA.md is the reference; carried as "a drift check between SCHEMA.md
  and `pg_dump --schema-only`".
- Playwright e2e for claim → login (carried from Stage 4): the repo's browser harnesses use the
  Chrome DevTools Protocol directly (`tests/e2e/cdp.ts`); the claim flow still lacks one.

## Components added

| Path | What it is |
|---|---|
| `packages/geo/src/cluster.ts` | DBSCAN (grid-indexed), convex hull, circumscribed buffered hull, point-in-ring, percentile — pure |
| `apps/engine/src/workers/deadzone.ts`, `src/cli/deadzone.ts` | the learner (cluster → reconcile → retire) and its CLI |
| `apps/engine/src/lib/health.ts` | pipeline health (lag, dead letters, fleet), OTel gauges |
| `packages/telemetry` | SDK start, tracer/meter, traceparent across streams, instruments, `RollingWindow` |
| `apps/gateway/src/plugins/otel.ts` | a server span per request |
| `apps/gateway/src/routes/api/admin/observability.ts` | `/v1/admin/observability`, dead-zone rename |
| `apps/web/app/(admin)/admin/health/page.tsx`, `components/admin/dead-zone-map.tsx` | the console's Health page and zone map |
| `apps/web/lib/sentry.ts`, `instrumentation*.ts`, `apps/driver/src/lib/sentry.ts` | Sentry, scrubbed |
| `packages/db/migrations/0009_observability.sql` | zone retirement, outages closed by trip end, `obs_*` views, `busmitra_metrics` role, zone audit |
| `infra/grafana/**`, `infra/scripts/observability.sh`, compose profile `observability` | dashboards, alert rules, local Grafana |
| `apps/simulator/src/deadzone.ts` | route-owned injected zones, the presence rule, `sim deadzone-check` |
| `apps/simulator/src/load/{run,chaos,stack,seed,push-sink}.ts`, `tests/load/{sse.js,Dockerfile}` | the load and chaos harness |

## Files changed

Stage start = file hashes snapshotted 2026-09-24 06:53 over the tree at `9cabdb2` (Stages 0–7
and 6 were then committed as `09c10b4` by the owner at 20:55, mid-stage). Stage 8 files only;
Stage 9's are in M09.

| Status | Path | What changed and why |
|---|---|---|
| added | `packages/geo/src/cluster{,.test}.ts`; modified `packages/geo/src/index.ts` | clustering maths |
| added | `apps/engine/src/workers/deadzone{,.test}.ts`, `src/cli/deadzone.ts`, `src/lib/health{,.test}.ts` | learner, health |
| modified | `apps/engine/src/main.ts`, `package.json` | telemetry start, gauges, nightly learner, exports |
| modified | `apps/engine/src/workers/geo.ts`, `eta.ts` | spans; events carry the fix's trace |
| modified | `apps/engine/src/workers/notify.ts`, `notify.test.ts` | spans + send metrics; **one row claimed per sender** (was: 1,000 at once); interrupted rows marked |
| modified | `apps/engine/src/workers/presence.ts` | ignore retired zones |
| modified | `apps/engine/src/workers/tickets.ts`, `admin.test.ts` | "trip ended while silent" now read from the outage's missing exit point |
| added | `packages/telemetry/**` | new package |
| modified | `packages/redis/src/streams.ts`, `events.ts`, `redis.test.ts` | `tp` field; `groupInfo`, `streamLength` |
| modified | `packages/config/src/thresholds.ts`, `env.ts`; added `alerts.test.ts` | `ALERTS`, `telemetryEnv` |
| modified | `packages/db/src/client.ts`; added `client.test.ts`, `observability.test.ts` | **pool idle-error handler** (crash fix); metrics-role isolation |
| added | `packages/db/migrations/0009_observability.sql` | see Schema changes |
| added | `apps/gateway/src/plugins/otel.ts`, `routes/api/admin/observability{,.test}.ts` | spans, health endpoint, zone rename |
| modified | `apps/gateway/src/app.ts`, `server.ts`, `routes/ingest/index.ts`, `routes/stream/{hub,index}.ts`, `routes/tracker/index.ts`, `package.json` | wiring; ingest span → `stream:pings`; fan-out latency window; connection gauge; **graceful SIGTERM** |
| added | `apps/web/app/(admin)/admin/health/page.tsx`, `components/admin/dead-zone-map.tsx`, `lib/sentry{,.test}.ts`, `instrumentation{,-client}.ts`; modified `(admin)/admin/layout.tsx`, `package.json` | Health page, Sentry |
| added | `apps/driver/src/lib/sentry.ts`; modified `src/main.tsx`, `package.json` | lazy Sentry |
| added | `apps/simulator/src/deadzone{,.test}.ts`, `src/load/*`; modified `src/run.ts`, `src/cli.ts` | zones per route, `maxAttempts`, `load`, `chaos`, `deadzone-check` |
| added | `tests/load/sse.js`, `tests/load/Dockerfile` | k6 |
| added | `infra/grafana/**`, `infra/scripts/observability.sh`; modified `infra/docker/docker-compose.dev.yml` | Grafana |
| modified | `docs/ARCHITECTURE.md` (§5.7 as built, §12), `docs/SCHEMA.md` (§3, §10, §13), `docs/BUILD_PLAN.md` (folder structure), `.env.example`, `.gitignore`, `tsconfig.json`, `pnpm-lock.yaml` | docs and config |
| added | `vault/decisions/ADR-0009-observability-and-load.md`, `vault/benchmarks/load-300-v1.md`, runbooks `map-reconnecting-redis-down.md`, `history-and-console-down-postgres.md`, `alerts-late-or-missing.md`, `etas-wide-or-walking-times-missing.md`; modified `push-not-delivering.md` (§6) | ritual |

## Schema changes

| Migration | Change | Reversible? |
|---|---|---|
| `0009_observability.sql` | `dead_zones.retired_at`, `learned_at`, partial GIST index, audit trigger; trigger closing a trip's open outage when the trip ends (and a one-off close of rows already stranded); views `obs_eta_accuracy`, `obs_notification_delivery`, `obs_signal_outages`, `obs_dead_zones`; role `busmitra_metrics` (NOLOGIN) | yes — below |

```sql
DROP VIEW IF EXISTS obs_eta_accuracy, obs_notification_delivery, obs_signal_outages, obs_dead_zones;
DROP ROLE IF EXISTS busmitra_metrics;          -- after REVOKE USAGE ON SCHEMA public FROM it
DROP TRIGGER IF EXISTS trips_close_outages ON trips;  DROP FUNCTION IF EXISTS close_outages_on_trip_end();
DROP TRIGGER IF EXISTS audit_dead_zones ON dead_zones;
DROP INDEX IF EXISTS dead_zones_active;
ALTER TABLE dead_zones DROP COLUMN IF EXISTS retired_at, DROP COLUMN IF EXISTS learned_at;
DELETE FROM supabase_migrations.schema_migrations WHERE version = '0009';
```
The outages the migration closed stay closed (their `recovered_at` is the trip's end) — harmless.

## Configuration

| Variable | Purpose | Where to obtain | Secret? |
|---|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | turns telemetry on (gateway + engine) | `http://localhost:4318` locally; Grafana Cloud's OTLP gateway | no |
| `OTEL_EXPORTER_OTLP_HEADERS` | Grafana Cloud auth header | Grafana Cloud → OTLP | **yes** |
| `OTEL_TRACES_SAMPLER`, `…_ARG` | sampling (`parentbased_traceidratio`, `0.1` in production) | — | no |
| `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_DSN`, `VITE_SENTRY_DSN` | Sentry for web (client, server) and driver | Sentry project settings | no (DSNs are public) |
| `busmitra_metrics` password | Grafana's Postgres datasource | set by the operator (`ALTER ROLE … LOGIN PASSWORD`) | **yes** |

## Technical decisions

Full reasoning in [ADR-0009](../decisions/ADR-0009-observability-and-load.md). In short:
- **A trace crosses Redis as a `tp` field beside `d`**, never inside a contract.
- **History from aggregate views, live numbers from metrics**; Grafana's role sees no table.
- **The console computes the same alert rules** as Grafana, so the TD needs no Grafana login.
- **k6 + xk6-sse in Docker**, orchestrated by a Node harness that owns its own stack.
- **Dead zones are retired, not deleted**, and must be seen on ≥ 2 trips; only outages that
  really recovered count; the hull is grown 60 m because the entry point precedes the silence.
- **Simulated dead zones belong to the route** (they used to be per bus): a place that recurs is
  the only thing a learner can learn.
- **Notification senders claim one row at a time** (was: the whole batch up front) — chosen after
  the worker drill; it also removes the per-batch straggler barrier (T0 to 600: 0.48 s PGlite,
  0.86 s Postgres 15 with a 20 ms stub; 6.4 s at FCM-like latency in the load run).

## Gotchas and failure modes

- **Symptom:** mid–load test, the gateway and the engine both exited with `Error: Connection
  terminated unexpectedly … Emitted 'error' event on BoundPool`.
  **Cause:** Postgres restarted; `pg.Pool` emits `error` for an idle client whose connection
  dies, and with no listener Node treats it as uncaught. **Any database restart or failover would
  have taken the whole system down** — the opposite of ARCH §11.
  **Fix:** `createPgDb` listens and logs; the pool replaces the client.
  **Prevention:** `client.test.ts` terminates a pooled backend on a real server (CI's postgres15
  job); the Postgres chaos drill (71 s outage, live map unaffected).
- **Symptom:** the local Supabase Postgres went into recovery mode, killing every connection.
  **Cause:** `GRANT busmitra_metrics TO CURRENT_USER` **segfaults** Supabase Postgres
  15.8.1.085 (signal 11, reproduced on a scratch container). **Fix:** name the role explicitly.
  **Prevention:** a comment at the only call site; never use `CURRENT_USER` in a role grant on
  Supabase.
- **Symptom (chaos drill):** SIGKILL of the engine after 49 of 300 pushes → 64 rows "claimed,
  never finished" for ever. **Cause:** at-most-once transport (ADR-0004) leaves the in-flight rows;
  before this stage the worker claimed **1,000** rows at once, so the same kill would have left
  ~250 students without the buzz. **Fix:** one claim per free sender (≤ 64 in flight); rows still
  unfinished after 2 min are marked `interrupted`. **Prevention:** the restart test asserts ≤ 64
  stranded and the sweep.
- **Symptom:** the drill for OSRM showed *faster* stop pages under flood. **Cause:** the walking
  time came from `walk_eta_cache`; the flood never touched the path being timed. **Fix:** the
  drill moves the student's home pin before every probe (the trigger empties the cache) and
  floods both profiles. A drill that cannot fail proves nothing — read every verdict.
- **Symptom:** the VAPID drill "passed" with 0 notification rows. **Cause:** it waited for "no
  undecided rows" before any row existed. **Fix:** wait for n rows *and* none undecided.
- **Symptom:** k6 reported T0 latency −29 s and some frame ages −32 s. **Cause:** k6 runs in the
  colima VM, whose clock stepped ~29 s mid-run after the laptop slept 14 h. **Fix:** judge
  latency on the gateway (same clock as the fix); time the T0 against the host's send time.
- **Symptom:** every page logged a CSP violation "Refused to evaluate … eval". **Cause:** Zod 4
  probes `Function("")` for its JIT. **Fix:** `z.config({ jitless: true })` in the browser.
- **Symptom:** Sentry added 78 kB to every student's first load with no DSN set (shared JS 182 →
  104 kB after the fix). **Cause:** a static import in `instrumentation-client.ts`. **Fix:**
  dynamic import behind the DSN check (driver app: its own chunk, 0 bytes without a DSN).
- **Symptom:** Sentry 11 silently collects user info, headers, bodies, query strings and
  **stack-frame local variables** by default. **Fix:** `dataCollection` with every category off,
  plus a scrubber; tested.
- **Symptom:** the key-registry guard failed on a log label `"fleet:live advancing"`.
  **Cause:** any Redis-key-shaped string outside `keys.ts` is flagged (invariant 15). Reworded;
  the guard was right.
- **Symptom:** pushes to the load sink failed TLS. **Cause:** `web-push` only speaks HTTPS.
  **Fix:** a throwaway CA and `NODE_EXTRA_CA_CERTS` on the harness's own engine.
- **Symptom:** `docker compose` bind mounts from `/var/folders` or `/private/tmp` produced empty
  directories. **Cause:** colima shares only the home directory with its VM. **Fix:** work dirs
  under the repository (git-ignored).
- **Symptom:** a 10-minute fleet run with dead zones recorded **zero** outages. **Cause:** not a
  bug — the seeded routes average 35 km and injected zones start 5 km+ in, so buses never reached
  them. A one-hour run recorded 114 outages (113 recovered). **Lesson:** a live learning check
  needs hours of repeated trips per route; the deterministic test is the verification.
- **Symptom:** the one-hour live run learned one zone the simulator never injected. **Cause:** the
  dev gateway and engine run with `--watch`, and editing sources (and the pre-commit hook's
  `prettier --write`) restarted them mid-run: 404 send retries, silences of 85–330 s, outages that
  are artefacts. Ingest itself stayed perfect (19,993 fixes, 0 missing, 0 duplicated).
  **Prevention:** never edit sources during a measurement run (already in the project memory);
  the artefact zone was retired locally.
- **Symptom:** `pnpm dev` restarted the adapter endlessly ("GATEWAY_URL is not set"). **Cause:**
  turbo runs every package's `dev` script. **Fix:** the adapter has no `dev` script; it runs only
  where wired trackers exist (`pnpm --filter @busmitra/adapter start`).
- **Watch for:** the laptop's Desktop is iCloud-synced; after a long sleep iCloud recreated the
  tree and left 255 "… 2" conflict copies (incl. `.git/index 2`). They were identical or stale
  and removed; `.gitignore` now refuses them. Moving the repository out of `~/Desktop` is the
  real fix (owner's call).

## Verifying locally

```bash
pnpm test                                          # 568 tests (Redis + PGlite)
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  pnpm vitest run packages/db apps/engine apps/gateway   # 292 on Postgres 15
bash infra/scripts/observability.sh                # Grafana :3001 → Bus Mitra — overview
# stop `pnpm dev` (the harness runs its own gateway + engine), then:
docker build -t busmitra-k6 tests/load
pnpm sim load --clients 600 --minutes 10 --otlp http://localhost:4318
pnpm sim chaos redis     # and postgres | worker | osrm | vapid
pnpm sim deadzone-check --learn                    # after a `sim run` with dead zones
```
Expected: the load report's `gatewayPingToFrameS.p95` ≈ 4 s, `t0.duplicatePushes` 0, every
`t0` count equal to the clients, `lag.lastThirdMean` 0; each drill's `lostOrDuplicated` 0.

## Performance

| Metric | Target | Measured | Conditions |
|---|---|---|---|
| Fix → frame p95, 600 students | < 6 s | **4.04 s** | 30 buses, no focus scoping, one laptop (load-300-v1) |
| Fix → frame p95, 1,000 students | degrades gracefully | **4.07 s**, 0 stream errors | same |
| T0 to 600 / 1,000: center rows, SSE frames, pushes | all, < 30 s | all; last push **6.4 s / 9.7 s**; **0 duplicates** | FCM-shaped push sink |
| Consumer lag during load | no growth | max 4, 0 at start and end | 10 min steady state |
| Ingest → fan-out | — | **17 ms** | one trace in Tempo |
| Dead-zone learning vs injected | every learnable zone, nothing else | **8/8 found, 0 false** | 5 seeds × 12 trips, 9 injected (1 merged) |
| Redis down 33 s | no loss | 268/268 fixes, gateway up throughout | 6 buses |
| Postgres down 71 s | live map unaffected | newest fix ≤ 4 s old; drained 2 s after; 0 lost | 6 buses |
| Engine SIGKILL mid-T0 (300) | 0 duplicates | 300/300 pushed, **0 duplicates**, 64 in flight | after 49 pushes |
| OSRM car + foot flooded 60 s | graceful | stop page p50 717 ms, max 1.13 s, all 200 with a walking time; lag 0 | 17,164 flood requests |
| VAPID key revoked | fallback | 50/50 refused → 50/50 by SMS; alert fired | 50 students, T1 |

## Rolling back

Code: revert the stage's files. Schema: the SQL in *Schema changes*. Data written: `dead_zones`
rows with `learned_at` (safe to leave; retire with `UPDATE dead_zones SET retired_at = now()
WHERE learned_at IS NOT NULL` to stop classification), outage rows the trigger closed (leave).
Telemetry and Sentry are off without their environment variables.

## Carried forward

- A clean multi-hour live learning run (no source edits, `pnpm dev` untouched) with `pnpm sim run
  --minutes 180` then `pnpm sim deadzone-check --learn`: the one-hour attempt was spoiled by
  dev-server restarts and gave ≤ 3 observations per zone (fewer than minPts 4).
- **Soak gate:** ≥ 3 dead zones learned and classified correctly on real routes — needs ~2 weeks
  of real buses (Stage 9 pilot); `pnpm --filter @busmitra/engine deadzone` + the Health page.
- Grafana Cloud: create the stack, set `OTEL_EXPORTER_OTLP_*`, import the dashboard, provision
  the alert rules with `BUSMITRA_PROM_UID=grafanacloud-prom`, route alerts to a phone (deploy.md).
- Load v2 on production-shaped infrastructure, with focus scoping on and a sample of real FCM.
- The 5 s push timeout counts ~1 % of FCM's slow tail as failures (T0 students then get push +
  SMS); consider 8 s after measuring real FCM from Mumbai.
- *(optional)* the on-bus auto-detect prompt; a SCHEMA.md ↔ schema drift check in CI; a browser
  e2e for claim → login.
