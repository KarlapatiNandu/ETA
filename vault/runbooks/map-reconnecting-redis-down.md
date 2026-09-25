# Runbook — the map says "reconnecting" and trackers are buffering (Redis is down)

**Symptom:** students see the connection indicator stuck on *reconnecting*; drivers' apps show
"N waiting to send" growing; `/admin/health` cannot load live numbers; the gateway log has
`ingest: redis unavailable` and `sse hub: read failed, retrying`.

**What the system does by itself (measured, chaos drill 2026-09-24):** Redis stopped for **33 s**
while 6 buses reported. The gateway **stayed up** (30/30 health probes answered). Ingest answered
503, so every tracker kept its pings and retried with back-off. When Redis came back (AOF:
at most ~1 s of live state lost, ADR-0002) the fleet resumed at once, and the verifier found
**268/268 fixes in `positions`, 0 missing, 0 duplicated**. SSE clients reconnected by themselves
and replayed from `Last-Event-ID`.

## Do

1. Confirm: `redis-cli -u "$REDIS_URL" ping` (production: the Fly Redis console).
2. If Redis is down, restart it (`fly redis …` / `docker start busmitra-redis-1`). **Do not
   flush it** — `fleet:live` and the streams are the live fleet; the persister still owes
   Postgres every unwritten ping in `stream:pings`.
3. Watch `/admin/health`: consumer lag rises while the trackers flush their buffers, then falls to
   0 within a minute or two.
4. If Redis's data was lost (a new instance): the engine refills `fleet:live` from the last five
   minutes of `positions` at boot (`rehydrateFleet`) — restart the engine once Redis is up.

## Don't

- Don't restart the gateway or engine *while* Redis is down: they retry on their own, and a
  restart gains nothing.
- Don't tell drivers to end their trips: their phones are buffering exactly as designed.

## Rehearse

`pnpm sim chaos redis` (stop `pnpm dev` first) — stops the Redis container for 30 s under a
6-bus fleet and prints the verdict above.
