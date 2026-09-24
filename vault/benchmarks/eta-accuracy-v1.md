# ETA accuracy (v1) — simulated baseline

**Date:** 2026-09-23 · **Stage:** 5 · **Verdict:** pipeline verified; **not the soak gate**

> The Stage 5 gate is *bus ETA MAE < 90 s at a 10-minute horizon over ≥ 10 **real** trips*. This
> file is the same measurement over **simulated** trips. It proves the instrumentation works end
> to end and records how the cold-start blend behaves against synthetic traffic. Its number is not
> the gate, and the blend weights were deliberately **not** tuned against it: the simulator's
> traffic (random stalls, uniform dwell) is invented, and fitting to it would be fitting fiction.
> The real soak goes in `eta-accuracy-v2.md`.

## What was measured

For every trip, the ETA worker logs one prediction per stop as the predicted p50 enters each
horizon bucket `(H − 60, H]` for H = 600, 300 and 120 s. When `trip_stop_events` records the
arrival, the stop-events worker fills in the actual time, and `error_s = actual − predicted`.

```bash
pnpm sim eta-report --since 2026-09-23T14:40:00Z --bus SIM-
```

## Conditions

| | |
|---|---|
| Trips | the Stage 3/5 runs of 2026-09-23 after 14:40 UTC: 30 buses × 16 min, 10 × 14 min, 8 × 25 min, on the 8 seeded corridors |
| Traffic | the simulator: cruise 24–38 km/h with ±25 % wander, 0.3 stalls/km of 20–80 s, 15–45 s dwell at every stop, σ 8 m GPS noise, no dead zones |
| Model state | **cold start**: `segment_speeds` empty (no night has run yet), so every prediction is the cold blend `0.6·v_osrm·congestion + 0.4·v_live`, dwell 30 s |
| OSRM | local car profile, free-flow speeds per 200 m segment |
| Unresolved | 54 predictions had no arrival (the run ended first); excluded |

## Results

| Horizon | Predictions with an arrival | Trips | MAE | Bias (+ = bus later) | p90 abs error | Arrival within the predicted range |
|---|---|---|---|---|---|---|
| **10 min** | 34 | 30 | **146 s** | +59 s | 260 s | 70.6 % |
| 5 min | 40 | 33 | 82 s | +66 s | 181 s | 65.0 % |
| 2 min | 41 | 34 | 25 s | +13 s | 64 s | 80.5 % |

All 34 ten-minute predictions carried `confidence = low`: correct for a model with no history.

## Reading it

- **The error shrinks with the horizon as it should,** and the late bias is the expected shape of
  a cold start: the simulator stops a bus at random signals the model cannot know about, and
  `v_live` (an EWMA) forgets a stall within a few fixes.
- **The range is honest about 70 % of the time** at 10 minutes. A calibrated p90 should hold the
  arrival ~90 % of the time; the cold `p90 = p50 × 1.35` spread is too narrow for stop-and-go
  traffic. This is the first thing to revisit on real data, because a too-narrow range is what
  makes "leave now" late.
- **What should move the number on real buses:** history. After about a fortnight at two trips a
  day, rungs 3–4 of the ladder engage (ARCH §5.5), replacing the random-stall guess with each
  segment's measured median and p10.

## What happens next

1. Run the soak: one cooperative driver, one route, ≥ 10 trips with the driver app
   (tracker.md §2). `segment_speeds` fills nightly from those trips.
2. `pnpm sim eta-report --since <soak start>` (no `--bus` filter) → `eta-accuracy-v2.md`.
3. If the 10-minute MAE is ≥ 90 s: tune the §5.5 weights and the cold p90 spread on that data,
   re-measure, and only then start Stage 6.
