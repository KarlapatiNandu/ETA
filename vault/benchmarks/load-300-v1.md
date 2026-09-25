# Benchmark — load, 600 students + 1,000 headroom (v1)

> The file name keeps the build plan's original `load-300` (BUILD_PLAN Stage 8 exit); the target
> was revised to 600 concurrent students with a 1,000-client headroom run (ARCH §1).

**Date:** 2026-09-24 · **Stage:** 8 · **Harness:** `pnpm sim load` (`apps/simulator/src/load/run.ts`)
+ k6 1.5 with xk6-sse (`tests/load/sse.js`, built by `tests/load/Dockerfile`).

## Conditions

- One MacBook Air (Apple silicon) running everything: the gateway and the engine (Node 25,
  one process each, telemetry on and exporting to the local Grafana stack), Supabase Postgres 15
  and Redis 7 in colima (6 vCPU / 10 GiB VM), and k6 in the same VM.
- **30 simulated buses** through the real signed ingest path, 8 routes, GPS noise, dead zones,
  2 % duplicated and 2 % reordered batches.
- **N distinct students**, each with its own token, one SSE stream and one push subscription,
  connecting over 60 s and staying 10 minutes. **No focus scoping**: every student receives every
  bus (the worst case; real clients scope to their view).
- One **T0 announcement to all N** a third of the way in. Push goes to a local HTTPS sink with
  FCM-shaped latency (median 150 ms, 1 % stragglers of 2–6 s), trusted through a throwaway CA.
- Latency is measured **at the gateway**, on the clock that stamped the fix: `recorded_at` → the
  frame fanned out (`busmitra.sse.ping_to_frame`). The client adds < 50 ms of paint (ARCH §4).

## Results

| | Target | 600 students | 1,000 students |
|---|---|---|---|
| Streams opened / errors | all | 600 / 0 | 1,000 / 0 |
| Frames delivered | — | 2,043,438 | 3,405,475 |
| Fix → frame p50 / **p95** / max | p95 < 6 s | 4.01 / **4.04** / 4.07 s | 4.01 / **4.07** / 4.15 s |
| T0 in the notification center | all | 600 / 600 | 1,000 / 1,000 |
| T0 as a live SSE frame (after the send) | — | 600 / 600, p95 78 ms | 1,000 / 1,000, p95 146 ms |
| T0 pushes at the push service | all, < 30 s | 600 / 600, last **6.4 s** | 1,000 / 1,000, last **9.7 s** |
| Duplicate pushes | 0 | **0** | **0** |
| Consumer lag, max · first-third mean · last-third mean | no growth | 4 · 0 · 0 | 4 · 0 · 0 |
| Alerts firing during the run | none | none | none |

The fix → frame age of ~4 s is almost all *batching*, not processing: the tracker samples a fix
and sends its batch up to 5 s later (the simulator's phase puts the newest fix ~4 s before each
send); ingest → fan-out is **17 ms** in the traces (Tempo). The 1,000-client run is not slower in
any measured way — it "degrades gracefully" by not degrading.

About 1 % of pushes (4 of 600, 6 of 1,000) outlasted the engine's 5 s push timeout on the sink's
slow tail and were counted as failed; for a T0 those students also got the SMS they get anyway.
With a real push service that is a push *and* an SMS for ~1 % of students on a critical alert —
accepted; the timeout protects everyone else's delivery time.

## Runs that did not count

- Run 1 of 600 (15:45): all targets met, but the report's T0 timing compared the frame's
  `createdAt` with the k6 VM's clock, which had stepped ~29 s after the laptop slept. Fixed the
  harness to time against the host's send time.
- Run 2 of 600 (16:00): **the gateway and engine crashed** when the local Postgres restarted
  mid-run (an unhandled `pg.Pool` idle-client error — a real bug, fixed in `createPgDb`; M08).
  The Postgres restart was itself caused by a test statement that segfaults Supabase's Postgres
  (M08 gotchas).

## Reproduce

```bash
pnpm dev:down                                   # or stop `pnpm dev`: the harness runs its own stack
docker build -t busmitra-k6 tests/load          # once
bash infra/scripts/observability.sh             # optional: Grafana on :3001
pnpm sim load --clients 600 --minutes 10 --otlp http://localhost:4318 --out report-600.json
pnpm sim load --clients 1000 --minutes 10 --out report-1000.json
```

v2 should run against production-shaped infrastructure (Fly `bom` + Supabase Pro) with real FCM
for a sample of real browsers, and with focus scoping on, as students' apps really do.
