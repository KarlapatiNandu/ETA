# Bus not appearing

**Symptom:** a bus is running, but it is not on the map / not in `fleet:live` / its positions
have stopped. Students are asking where Bus 14 is.

Work down the pipe in this order. Each step tells you whether to stop or carry on, and the
whole path is: **phone → gateway → `stream:pings` → geo worker → `fleet:live`**, with the
persister writing `positions` off to one side. A bus missing from the *map* but present in
`positions` is a different fault from a bus missing everywhere.

> Dev: `DB` below is `docker exec supabase_db_busmitra psql -U postgres -d postgres`,
> `R` is `docker exec busmitra-redis-1 redis-cli`. Production: the Supabase SQL editor and
> the Redis console.

---

## 0. One bus, or all of them?

```bash
R HLEN fleet:live          # how many buses have live state at all
R HGET fleet:live <bus_id> # the one you care about
```

- **All buses missing** → skip to §5 (the engine or Redis), then §6.
- **One bus missing** → §1.

---

## 1. Is there an open trip for that bus?

```sql
-- DB
SELECT t.id, t.status, t.started_at, t.ended_at, r.name
  FROM trips t JOIN routes r ON r.id = t.route_id
  JOIN buses b ON b.id = t.bus_id
 WHERE b.bus_number = '14' AND t.service_date = (now() AT TIME ZONE 'Asia/Kolkata')::date
 ORDER BY t.created_at DESC;
```

| What you see | Meaning | Do |
|---|---|---|
| No row | The driver never pressed **START TRIP** | Call the driver. Nothing else will help. |
| `status = 'completed'` while the bus is still running | The driver pressed END, or started a trip on a different route (which closes the old one) | Ask them to start the trip again. |
| `status = 'running'`, `started_at` recent | The trip is open — the fault is further down | §2 |

## 2. Is the phone sending?

```sql
-- DB: the freshest position for that bus, and how late it was
SELECT recorded_at, ingested_at, ingested_at - recorded_at AS lag, is_backfill, route_offset_m
  FROM positions WHERE trip_id = '<trip id>' ORDER BY recorded_at DESC LIMIT 5;
```

- **Rows arriving, `lag` under a few seconds** → the phone is fine; the fault is in the live
  path, not ingest. Go to §5.
- **Rows arriving with a large `lag` and `is_backfill = true`** → the phone was in a dead zone
  and is flushing its buffer now. Normal. The map catches up as the flush lands; the student
  sees "last seen N minutes ago" until then, which is honest.
- **No rows at all for this trip** → §3.

## 3. The phone is not reaching the gateway

Ask the driver what the app shows. The three chips at the top of the driver app are the whole
diagnosis, and the buffer count is the most important number on the screen:

| Driver app shows | Meaning | Fix |
|---|---|---|
| "No network — buffering", buffer count climbing | Dead zone or no data | Nothing to do. Pings are safe in IndexedDB and flush on reconnect (up to 20,000 — more than a day). |
| "Phone clock is wrong — set date & time to automatic" | Ingest rejects a signature more than ±5 min from the server clock (`401 stale_timestamp`) | Set the phone to automatic time. Buffered pings then go out. |
| "This phone is not paired any more" | `401 bad_signature`: the secret was rotated, or the tracker row was re-paired to another phone | Issue a new pairing link (§4). |
| "Location permission is off" | The app has no GPS permission | Android settings → the app → Location → Allow while using. |
| "Screen lock lost — reopen the app" | Wake Lock was released and could not be re-acquired (battery saver) | Re-open the app; disable battery saver for it. The phone must be charging and mounted. |
| "This trip was closed on the server" | Someone (or another start) ended the trip | Start the trip again. |
| Counters look fine, nothing arriving | The gateway is unreachable from the phone's network | §6 |

```bash
# gateway logs: is anything arriving from this device at all?
grep 'sim-14\|phone-14' gateway.log | tail -20     # device_uid of the phone
R GET "ratelimit:ingest:<device_uid>:$(( $(date +%s) / 60 ))"   # >120 means it is being throttled
```

## 4. Re-pair a phone

```bash
pnpm tracker provision --bus 14              # new device, prints a pairing link once
pnpm tracker rotate --device phone-14-a1b2   # same device, new secret (old one works 10 more minutes)
```

Open the link **on the driver's phone**. The secret is shown once and never again — it is
encrypted in `trackers.secret_enc`, not hashed, but nothing reads it back out to a person.

## 5. The engine is not turning pings into live state

```bash
R XINFO GROUPS stream:pings     # per consumer group: pending, lag
R XLEN stream:pings
```

| What you see | Meaning | Do |
|---|---|---|
| `geo` lag grows, `pending` grows | The geo worker is stopped or wedged | Restart the engine. Entries are re-read from the group: nothing is lost. |
| `geo` fine, `persist` lag grows | Postgres is unreachable or slow | The live map is unaffected (invariant 1). Check Postgres; the persister retries with backoff and keeps entries pending. |
| Both lags 0, but `fleet:live` has no entry | The pings are being processed and discarded | Engine logs: `geo: unknown route, ping skipped` means the trip's route is not loadable (deleted draft, or Redis cache holds a stale id) — check `SELECT route_id FROM trips WHERE id = …` resolves. |
| `stream:pings:dead` is non-empty | Rows the persister could not write even one at a time | `R XRANGE stream:pings:dead - + COUNT 5` — the `reason` field says why (usually a `recorded_at` outside every partition). Not retried automatically. |

```bash
# is the bus's entry simply stale rather than missing?
R HGET fleet:live <bus_id>   # ts, state, cadence — compare ts with now
```

A bus whose entry is present but old is a **presence** problem (amber/red on the map), not an
ingest problem: the sweeper (Stage 3) owns it. `flag: "off_route"` with `s: null` means the bus
is more than 75 m off its route for 3 fixes running — a detour or the wrong route picked at
START; `s` deliberately stays null rather than showing an offset we do not believe.

## 6. Everything is missing

```bash
curl -s localhost:4000/healthz      # gateway up?
R PING                              # Redis up?
docker ps | grep -E "redis|supabase_db"
```

- **Redis down** → ingest answers `503` and phones buffer. Nothing is lost while they can
  buffer (20,000 pings each). Bring Redis back; the flush is automatic.
- **Gateway down** → same from the phone's point of view.
- **Postgres down** → the live map keeps working from Redis (that is the design, ADR-0002).
  Ingest keeps flowing: tracker and trip lookups are cached in the gateway with stale-on-error.
  New trips cannot be *started*, because that is a write.

---

## What "never happened" looks like

If nothing above matches and the positions simply are not there, check the one case that
looks like a bug and is not: **a ping the gateway refused per-ping**. The ingest response lists
them (`rejected: [{index, reason}]`) and the driver app shows "N pings refused":

| reason | Meaning |
|---|---|
| `future_timestamp` | The phone's clock is ahead by more than 5 minutes |
| `too_old` | Recorded more than 48 h ago — outside every positions partition, and far past useful |

Those pings are dropped on purpose and never retried; fix the clock and the next ones land.
