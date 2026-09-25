# Runbook — ETAs are slow, wide, or walking times are missing (OSRM is overloaded or down)

**Symptom:** the stop page takes a second or more; walking time ("12 min walk") is missing;
ETA ranges look wider than usual and the confidence dot drops; the geo box's CPU is pinned.

**What the system does by itself (measured, chaos drill 2026-09-24):** OSRM car **and** foot
flooded by 192 clients for 60 s (17,164 heavy route requests with alternatives), while 6 buses
reported and a student's home pin moved before every probe so each stop-page load needed a fresh
OSRM call. The stop page slowed from **40 ms to p50 717 ms, max 1.13 s**, answered **200 every
time**, and had a walking time on all 23 probes. The gateway's own health check stayed ≤ 22 ms,
consumer lag stayed 0, and all 268 fixes were stored. Recovery was immediate (12 ms after).

Why it holds: OSRM is never on the live path. Walking times are cached per student and stop for
24 h (`walk_eta_cache`); OSRM free-flow speeds per route for 24 h (`route:{id}:osrm`); calls have
timeouts (foot 5 s, car 15 s). **With OSRM entirely down**, walking time is omitted rather than
guessed (invariant 2) and the ETA blend falls back to history and live speed (ARCH §11).

## Do

1. `ssh geo-box 'docker stats --no-stream'` — which container is hot?
2. A flood from outside (a scraper found `geo.<domain>`)? The path token (`GEO_TOKEN`) should make
   that impossible — rotate it (runbook: campus-it handover §2) and restart gateway + engine.
3. Genuine load (the whole campus opened the app at 07:40 with new home pins)? It passes in
   minutes as the cache fills. If it recurs daily, move to a 8 vCPU box.
4. OSRM crashed → `docker compose up -d osrm-car osrm-foot` on the geo box. Nothing to do on
   the gateway/engine side; they use it again on the next call.

## Rehearse

`pnpm sim chaos osrm` (stop `pnpm dev` first).
