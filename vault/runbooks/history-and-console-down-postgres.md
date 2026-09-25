# Runbook — history, search and the console fail, but the live map works (Postgres is down)

**Symptom:** the live map keeps moving, but stop search, the stop page, sign-in, the console and
the notification center return errors; the alert *Pings the persister could not write* may fire;
gateway/engine logs show `db: idle connection lost (the pool replaces it)` or connection errors.

**What the system does by itself (measured, chaos drill 2026-09-24):** Postgres stopped for
**71 s** under 6 reporting buses. The live map did not notice — the newest fix in `fleet:live`
was never more than **4 s** old during the outage (invariant 1: Postgres is never on the live
path). The persister stopped writing and let `stream:pings` hold the backlog (lag 74 entries at
restore), then **drained in 2 s**; the verifier found **268/268 fixes, 0 missing, 0
duplicated**. Presence transitions carried on; outage rows were written when the database
returned.

⚠️ **Before Stage 8 this took the whole system down.** An idle pooled connection dying made
`pg.Pool` emit an `error` nobody handled, and Node killed the gateway *and* the engine (found
when a database restart hit a load test). `createPgDb` now logs and carries on
(`packages/db/src/client.ts`, tested against a real server by terminating the backend).

## Do

1. Confirm: Supabase dashboard → project status; or `psql "$DATABASE_URL" -c 'select 1'`.
2. Supabase incident → wait; nothing to do on our side. Our own Postgres → restart it.
3. After it returns, watch `/admin/health`: the persister's lag back to 0; **Unsaved positions**
   must be 0. If it is not, the dead letters are in `stream:pings:dead` with their reason —
   see the `stream:pings:dead` row in [bus-not-appearing.md](bus-not-appearing.md).
4. Tell the TD console users it is back; nothing they did during the outage was half-saved
   (every admin mutation is one transaction).

## Don't

- Don't restart the gateway or engine: since Stage 8 they ride out the outage.
- Don't drain or trim `stream:pings` by hand: it *is* the backlog the persister owes.

## Rehearse

`pnpm sim chaos postgres` (stop `pnpm dev` first).
