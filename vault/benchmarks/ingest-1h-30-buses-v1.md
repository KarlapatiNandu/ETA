# Ingest soak — 30 simulated buses, one hour (v1)

**Date:** 2026-09-23 · **Stage:** 2 exit criterion · **Verdict:** pass

## What was measured

BUILD_PLAN Stage 2: *"30 simulated buses ingest for one hour with zero dropped or duplicated
pings"*, plus the replay and backfill criteria, on the full local stack: driver-equivalent
trackers → gateway → `stream:pings` → geo worker + persister → Supabase Postgres 15.

```bash
pnpm sim run --buses 30 --minutes 60 --stagger 10 --airplane 5:10:13
```

Each bus drove one of 8 seeded corridors on real Hyderabad roads with σ ≈ 8 m GPS noise, 1–2
dead zones per route (400–900 m of no network), stalls, and — for one bus in seven — an
off-route detour. 2% of batches were sent twice and 2% of consecutive batches were swapped in
order. Bus 5 was additionally offline from minute 10 to minute 13.

## Conditions

| | |
|---|---|
| Machine | MacBook Air (Apple silicon), everything on one laptop: Postgres, Redis, OSRM ×2, tiles, gateway, engine, simulator |
| Postgres | Supabase local stack, Postgres 15.8 + PostGIS |
| Wall clock | 07:48:56 → 08:51:54 UTC (63 min, including the stagger and turnarounds) |
| Note | the gateway restarted twice mid-run (file-watch during development), which is why retries are non-zero — and is itself evidence that a restart is survivable |

## Results

| Metric | Target | Measured |
|---|---|---|
| Distinct fixes sent | — | **19,696** |
| Rows in `positions` for those trips | = fixes sent | **19,696** |
| Dropped | 0 | **0** |
| Duplicated | 0 | **0** |
| Unexpected rows | 0 | **0** |
| Batches sent | — | 19,398 (384 duplicates, 40 reconnect flushes) |
| Gateway acknowledged | — | 20,111 pings (> distinct: duplicate batches are accepted and collapse at the unique index) |
| Rejected pings | 0 | **0** |
| Batches that never got through | 0 | **0** (349 retries absorbed) |
| `is_backfill` correct | exact | **7,771 / 7,771**, 0 wrongly flagged, 0 missed |
| `fleet:live` moved backwards in time | 0 | **0** across 64,260 samples (1 Hz, all 30 buses) |
| Fixes stored with NULL offset | = off-route only | 102 of 19,696 (the injected detours) |
| Persister drain after the last batch | — | under 3 minutes to `pending = 0, lag = 0` |

Sustained rate: ~5.2 pings/s ingested and persisted, against the ~6 writes/s the architecture
sizes for at full fleet (ARCH §1).

## What this does and does not prove

**Does:** the pipeline is lossless and idempotent under duplicates, reordering, dead zones and
a gateway restart; backfill marking matches the 30 s rule exactly; a backfilled flush never
moves a bus's live entry backwards.

**Does not:** say anything about real cellular behaviour, real GPS quality, Android's
background throttling, or latency to a student's screen. Ping-to-pixel latency is Stage 3's
measurement, and the phone-on-a-bus behaviour is the Stage 5 soak.

## Reproducing

`pnpm dev`, then `pnpm sim seed && pnpm sim run --buses 30 --minutes 60`. The run verifies
itself and exits non-zero on any discrepancy; `--out report.json` keeps the full per-trip
manifest.
