# Bus Mitra — Stage Tracker

> **Review this before building each stage, and update it the moment anything changes.**
> Working rules live in [Read_this_first.md](Read_this_first.md). Stage detail lives in [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md).
>
> Exit criteria below are transcribed from the build plan so they can be ticked in place. If the two ever disagree, the build plan wins and this file is stale — fix it.

**Last updated:** 2026-09-20 · **Current stage:** Stage 0 — not started · **Repo state:** docs only, no code

---

## 1. Status at a glance

| # | Stage | Build order | Status | Started | Completed | Vault entry |
|---|---|---|---|---|---|---|
| 0 | Foundations | 1st | ⬜ Not started | — | — | `M00-foundations.md` |
| 4 | Identity and roster | 2nd | ⬜ Not started | — | — | `M04-identity.md` |
| 1 | Geo core and route capture | 3rd (pure-geo half runs with Stage 4) | ⬜ Not started | — | — | `M01-geo-core.md` |
| 2 | Ingestion pipeline | 4th | ⬜ Not started | — | — | `M02-ingestion.md` |
| 3 | Live delivery | 5th | ⬜ Not started | — | — | `M03-live-delivery.md` |
| 5 | Stops, search and personal ETA | 6th (parallel with 7) | ⬜ Not started | — | — | `M05-search-eta.md` |
| 7 | Admin console | 6th (parallel with 5) | ⬜ Not started | — | — | `M07-admin-console.md` |
| 6 | Notification spine | 7th | ⬜ Not started | — | — | `M06-notifications.md` |
| 8 | Learning, observability and load | 8th | ⬜ Not started | — | — | `M08-observability.md` |
| 9 | Production and hardware | 9th | ⬜ Not started | — | — | `M09-production.md` |

Status values: ⬜ Not started · 🟡 In progress · 🟢 Complete · 🔵 Complete except soak gate · 🔴 Blocked

**Build order:** `0 → 4 → 1 → 2 → 3 → 5/7 → 6 → 8 → 9`. Stage numbers are identities, not an order.

---

## 2. External dependencies — the things with multi-week clocks

These stall the build if left unchased. Update the moment anything moves.

| Dependency | Requested on | Status | Blocks | Notes |
|---|---|---|---|---|
| MSG91 DLT registration — entity, sender header, **and a content template per tier** | — | ⬜ Not started | Stage 6 (SMS), Stage 4 (OTP claim) | 1–2 week regulatory clock. Start on day one of Stage 0. Draft T0/T1 template text even though copy is not final. |
| TD roster CSV (roll no, name, admission year, phone, branch) | — | ⬜ Not started | Stage 4 | Risk register rates late/incomplete as **High**. `phone_e164` is nullable for exactly this reason. |
| TD actual daily ridership figures | — | ⬜ Not started | Stage 8 sizing, production sizing | Five-minute question. If materially above 1,500, re-derive SSE fan-out and Fly.io sizing. |
| Cooperative driver + one route for the Stage 5 ETA soak (≥10 instrumented trips) | — | ⬜ Not started | Stage 5 exit / start of Stage 6 | **Arrange during Stage 4.** ~1 week of real riding; Stage 5's 6 build-days do not contain it. |
| Cohort definition settled with TD (shift split vs academic year) | — | ⬜ Not started | Stage 4 RLS + audience queries | Two enum values fit a shift split and cannot express a year group. Cheap now, an enum migration later. |
| ODbL position on surveyed route geometry | — | ⬜ Not started | Stage 9 public release | Map-matched traces plausibly make `routes`/`stops` a Derivative Database. Ten minutes of reading now. |

---

## 3. Stages

### Stage 0 — Foundations · ⬜ Not started

**~3 days.** Nothing user-visible. Every later stage is faster or slower depending on how honestly this one is done.
**Depends on:** nothing. **Start commit:** — · **End commit:** —

- [ ] `pnpm dev` starts every container, both OSRM profiles answer a test route, and the tile server returns a tile
- [ ] `pnpm test` and `pnpm typecheck` pass in CI
- [ ] A missing env var fails the boot with a readable message naming the variable
- [ ] DLT registration submitted; roster request sent
- [ ] `vault/modules/M00-foundations.md` written

**Watch for:** `PingBatch` must carry `cadence_s` from the very first version — retrofitting it into a contract hardware trackers already speak is what the adapter seam exists to avoid. OSRM preprocessing wants ~8 GB RAM; clip to a Hyderabad bbox (GitHub release assets cap at 2 GiB per file).

**Files touched this stage:** _(fill as you go)_

---

### Stage 4 — Identity and roster · ⬜ Not started

**~4 days.** Build immediately after Stage 0; the pure-geo half of Stage 1 runs alongside.
**Depends on:** Stage 0; TD roster CSV; cohort definition. **Start commit:** — · **End commit:** —

- [ ] Full claim flow works end to end with a real SMS
- [ ] Roster enumeration attack returns identical responses for existing and non-existing roll numbers
- [ ] RLS adversarial suite passes; policies exist on 100% of tables
- [ ] Junior/senior cohorts correctly derived across an academic-year boundary
- [ ] `vault/modules/M04-identity.md` + `runbooks/student-cannot-claim.md`

**Watch for:** rows without a phone must import successfully (only *claiming* requires one). Plumb `set_config('app.client_ip', …, true)` per request or `audit_log.ip`/`user_agent` are silently NULL forever. Password recovery is a custom SMS flow — the synthetic `@students.busmitra.internal` addresses are non-routable by design.

**Files touched this stage:** _(fill as you go)_

---

### Stage 1 — Geo core and route capture · ⬜ Not started

**~6 days.** The mathematical heart, plus the tooling to get route data you do not currently have.
**Depends on:** Stage 0 (geo half); Stage 4 (route editor only). **Start commit:** — · **End commit:** —

- [ ] `packages/geo` at >90% line coverage, including adversarial fixtures: GPS spike, backward jitter, 83 m ping gap at speed, route self-intersection
- [ ] At least one real route surveyed, matched, corrected and published
- [ ] Simulator drives 30 buses on real routes with injected noise and dead zones
- [ ] `vault/modules/M01-geo-core.md` + `ADR-0003-route-versioning.md`

**Watch for:** the global re-snap recovery after 4 sustained backward pings, and the `skipped` rule — omitting either produces a silently frozen trip, not an error. OSRM `/match` caps at 100 coordinates by default; chunk with ~15 points of overlap or raise the limit.

**Files touched this stage:** _(fill as you go)_

---

### Stage 2 — Ingestion pipeline · ⬜ Not started

**~5 days.** From a phone on a dashboard to a durable, replayable stream.
**Depends on:** Stage 1 geo core. **Start commit:** — · **End commit:** —

- [ ] 30 simulated buses ingest for one hour with zero dropped or duplicated pings
- [ ] Airplane-mode test: full backfill, correct ordering, `is_backfill` set, `fleet:live` unaffected
- [ ] Replayed batch produces no duplicate rows (unique index holds)
- [ ] Forged HMAC and stale-timestamp requests are rejected
- [ ] `vault/modules/M02-ingestion.md` + `runbooks/bus-not-appearing.md`

**Watch for:** Wake Lock is released on every visibility loss and does not return on its own — re-acquire on `visibilitychange`. `COPY` has no `ON CONFLICT`: stage into an unlogged table, then `INSERT … SELECT … ON CONFLICT DO NOTHING`.

**Files touched this stage:** _(fill as you go)_

---

### Stage 3 — Live delivery · ⬜ Not started

**~5 days.** The first time this looks like a product.
**Depends on:** Stages 2 and 4. **Start commit:** — · **End commit:** —

- [ ] 30 buses live on the map with smooth interpolation, no visible jumps
- [ ] All four presence states render and transition correctly at **both** the moving and stationary cadence — a parked bus never goes amber
- [ ] `SIGKILL` on the gateway then restart locks nobody out of reconnecting (TTL keys expire; no phantom connections)
- [ ] Killing the network mid-stream reconnects and replays missed events without a page reload
- [ ] p95 ping-to-pixel latency under 6 s, measured, not assumed — **measured: ___**
- [ ] `vault/modules/M03-live-delivery.md` + `ADR-0001` (formalise the SSE decision)

**Watch for:** thresholds are 3× and 9× the reported cadence, never absolute seconds. Only broadcast-class events are replayable from `stream:events`.

**Files touched this stage:** _(fill as you go)_

---

### Stage 5 — Stops, search and personal ETA · ⬜ Not started

**~6 days + a real-bus soak.** Where the app becomes useful rather than merely impressive.
**Depends on:** Stage 3. Runs parallel with Stage 7. **Start commit:** — · **End commit:** —

- [ ] Fuzzy search returns correct stops for 20 hand-written misspellings
- [ ] Area search ("Dilsukhnagar") returns all stops within 2 km with serving buses
- [ ] Walking ETA within 20% of a stopwatch-timed real walk
- [ ] **Soak gate:** bus ETA MAE < 90 s at a 10-minute horizon over ≥10 real trips — **measured: ___** *(may complete during Stage 7; **blocks the start of Stage 6**)*
- [ ] `vault/modules/M05-search-eta.md` + `benchmarks/eta-accuracy-v1.md`

**Watch for:** the leave-now evaluator **emits the event only** — Stage 6 delivers it. With ~2 trips a day only the coarse `segment_speeds` rungs will have samples; an MAE against a cold-start blend is the honest baseline.

**Files touched this stage:** _(fill as you go)_

---

### Stage 7 — Admin console · ⬜ Not started

**~6 days.** The Transport Department's half of the product. Build while the Stage 5 soak accumulates.
**Depends on:** Stage 3 (and Stage 4 auth). **Start commit:** — · **End commit:** —

- [ ] A non-technical TD member completes all three core workflows unassisted in a usability session
- [ ] Malformed CSV is rejected at preview with per-row, per-column errors and sends nothing
- [ ] Identical CSV re-upload does not re-notify
- [ ] Every admin mutation appears in `audit_log` with correct before/after
- [ ] `vault/modules/M07-admin-console.md` + `runbooks/csv-upload-failed.md`

**Watch for:** nothing reaches phones without a rendered preview, a resolved recipient count and an explicit confirmation. A *Custom* audience needs `announcement_recipients` — `audience_ref` is a single uuid.

**Files touched this stage:** _(fill as you go)_

---

### Stage 6 — Notification spine · ⬜ Not started

**~7 days. The largest, highest-risk stage.** Everything the product promises is delivered here.
**Depends on:** Stage 5 **including its MAE gate**; Stage 7; DLT registration. **Start commit:** — · **End commit:** —

- [ ] Restart the notify worker mid-fan-out → zero duplicates
- [ ] Flap a geofence boundary 20 times → one arrival notification
- [ ] Bus passes a stop unconfirmed → `skipped` fires and every subsequent stop still notifies
- [ ] Replay a full day of backfilled pings → zero retroactive alerts
- [ ] 600 users, one T0 announcement → all delivered within 30 s
- [ ] Revoke push permission mid-session → T1 falls back to SMS, notification center still written
- [ ] Kill switch active → T3 suppressed, T0 breaks through
- [ ] iOS: installed PWA receives push; uninstalled iOS receives SMS for T0/T1
- [ ] End-to-end alert latency (event → phone buzzes) p95 under 10 s — **measured: ___**
- [ ] Notification center is written even when every transport fails
- [ ] `vault/modules/M06-notifications.md` + `ADR-0004-tiering-and-dedupe.md` + `runbooks/push-not-delivering.md`

**Watch for:** SMS falls back on the push POST's HTTP status, **synchronously** — there is no delivery receipt to wait for. Parent `notifications` row and all `notification_recipients` rows in one transaction.

**Files touched this stage:** _(fill as you go)_

---

### Stage 8 — Learning, observability and load · ⬜ Not started

**~5 days of build + a ~2-week observation window that runs in parallel.**
**Depends on:** Stage 6. **Start commit:** — · **End commit:** —

- [ ] DBSCAN clustering verified against simulator-injected dead zones (deterministic, immediate)
- [ ] **Soak gate:** ≥3 dead zones learned and classified correctly on real routes *(completes during Stage 9)*
- [ ] 600-client k6 run: p95 < 6 s, zero dropped notifications, zero stream lag growth — **measured: ___**
- [ ] 1,000-client headroom run degrades gracefully rather than collapsing
- [ ] All five chaos drills executed with a written, tested runbook each (kill Redis · kill Postgres · kill a worker mid-fan-out · saturate OSRM · revoke a VAPID key)
- [ ] `vault/modules/M08-observability.md` + `benchmarks/load-300-v1.md`

**Watch for:** if the TD's ridership figures came back materially different in Stage 0, load-test against those, not against 600/1,000.

**Files touched this stage:** _(fill as you go)_

---

### Stage 9 — Production and hardware · ⬜ Not started

**~5 days plus hardware lead time.**
**Depends on:** Stage 8. **Start commit:** — · **End commit:** —

- [ ] Production deployed, monitored, backed up, **restore tested**
- [ ] Two-week pilot with ETA MAE < 90 s on real routes — **measured: ___**
- [ ] Hardware adapter validated against one physical tracker
- [ ] Handover pack complete
- [ ] `vault/modules/M09-production.md` + `runbooks/deploy.md` + `runbooks/rollback.md`

**Watch for:** staged rollout is 3 buses → two weeks of measurement → 10 → full 30. ETA accuracy is proven before any fleet-wide hardware spend.

**Files touched this stage:** _(fill as you go)_

---

## 4. Carried forward

Work inherited from a completed stage, and out-of-scope findings parked for the stage that owns them. Move items here the moment they are found; clear them when they land.

| Found in | For stage | Item | Status |
|---|---|---|---|
| — | — | _(none yet)_ | — |

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
| Module | M00 … M09 | 0 of 10 |
| ADR | ADR-0001 SSE over WebSocket (Stage 3) | ⬜ |
| ADR | ADR-0002 Redis live / Postgres record (drafted in ARCH §2.4) | ⬜ |
| ADR | ADR-0003 route versioning (Stage 1) | ⬜ |
| ADR | ADR-0004 tiering and dedupe (Stage 6) | ⬜ |
| ADR | ADR-0005 self-hosted tiles (drafted in ARCH §2.3) | ⬜ |
| Runbook | `bus-not-appearing.md` (Stage 2) | ⬜ |
| Runbook | `student-cannot-claim.md` (Stage 4) | ⬜ |
| Runbook | `csv-upload-failed.md` (Stage 7) | ⬜ |
| Runbook | `push-not-delivering.md` (Stage 6) | ⬜ |
| Runbook | 5 × chaos drill runbooks (Stage 8) | ⬜ |
| Runbook | `deploy.md`, `rollback.md` (Stage 9) | ⬜ |
| Benchmark | `eta-accuracy-v1.md` (Stage 5) | ⬜ |
| Benchmark | `load-300-v1.md` (Stage 8) | ⬜ |
