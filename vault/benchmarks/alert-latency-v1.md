# Alert latency (v1) — event → push delivered, and a 600-student T0

**Date:** 2026-09-24 · **Stage:** 6 · **Build:** uncommitted tree after Stage 7 (start `9cabdb2`)

## What was measured

1. **Event → push received by a browser.** `tests/e2e/stage6.ts`: a student in headless Chrome
   turns alerts on through the real Settings UI (a genuine `PushSubscription` with Google's push
   service). An admin then sends an announcement to that one student through the gateway. The
   clock starts before the admin's HTTP request and stops when the page receives the service
   worker's `postMessage` from its `push` handler. So the number covers: gateway commit →
   `stream:notify` doorbell → engine record → claim → VAPID-signed POST to FCM → FCM → Chrome →
   service worker → page.
2. **600 students, one T0.** `apps/engine/src/workers/notify.test.ts`: 600 synthetic students,
   each with one push subscription, one T0 announcement; the push transport is a stub answering
   `201` after 20 ms; SMS is a stub. Clock: from processing the doorbell to the last recipient row
   finished.

## Results

| Measure | Target (BUILD_PLAN Stage 6) | Measured | Conditions |
|---|---|---|---|
| Event → push in the browser, p50 | — | **590 ms** | n = 40, run 2 |
| Event → push in the browser, p95 | < 10 s *(to the phone buzzing)* | **2.4 s** (max 2.9 s) | n = 40, run 2 |
| Event → push in the browser, p95 | | 577 ms, **one 13.6 s outlier** | n = 20, run 1 |
| 600 students, one T0: recorded + handed to push | all within 30 s | **0.31 s** | PGlite, 20 ms push stub, 64 concurrent sends |
| same | | **0.55 s** | Supabase Postgres 15.8 (local) |

Run 2, in order (ms): 1564, 590, 1819, 2845, 1682, 2225, 1801, 1828, 2857, 2399, 671, 515, 853,
614, 561, 530, 505, 451, 440, 447, 735, 652, 576, 315, 275, 330, 212, 198, 1252, 174, 1345, 1554,
1472, 337, 976, 1109, 567, 501, 486, 449.

## What this does not measure

- **A phone.** "Event → phone buzzes" includes the phone's radio (often asleep), Android's or
  iOS's push daemon and Doze. Only a physical phone on cellular can measure that; it is the open
  part of the Stage 6 latency exit.
- **The push service at 600.** The 600-student run uses a stub. At real FCM latencies
  (~200–600 ms per POST here) and 64 concurrent sends, 600 pushes take roughly 600 / 64 × 0.6 s ≈
  6 s, inside 30 s — an estimate, not a measurement; Stage 8's k6 run measures it.
- **The 13.6 s sample in run 1** is unexplained. The pipeline up to the POST is milliseconds (the
  engine delivers within one 1 s pass at most), so it is most likely FCM, but the harness did not
  record the POST time. v2 should log the engine's POST timestamp per notification to split the
  number into "ours" and "the push service's".
