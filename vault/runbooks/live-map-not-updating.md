# Live map not updating

**Symptom:** a student's map shows buses that do not move, the connection chip says
"Reconnecting…" or "Offline", or a student cannot open the map at all ("At most 3 live
connections").

Work top to bottom; each step rules out a layer. (For a bus that never appears at all, start
with [bus-not-appearing.md](bus-not-appearing.md) instead: that is ingestion, not delivery.)

## 1. Is it one student or everyone?

- **Everyone:** go to step 2.
- **One student:** ask what the chip says.
  - "Offline" — their phone has no network. Nothing to fix server-side.
  - "Reconnecting…" for more than a minute — step 4 (their token, or the cap).
  - "Live", but a bus looks frozen — it is probably honest: an amber or red bus is drawn at its
    last true fix on purpose (invariant 2). Check its sheet: "last seen …" means the *bus* is
    not reporting, not that the map is broken. Go to `bus-not-appearing.md` for that bus.

## 2. Is the gateway serving streams?

```bash
curl -s localhost:4000/healthz                     # {"ok":true}
curl -sN localhost:4000/v1/stream -H "authorization: Bearer $TOKEN" | head -5
# expect: event: stream.ready … event: fleet.snapshot … then frames and ": hb" every 15 s
```

A `401` means the token (step 4). No output at all means the gateway is down or wedged: restart
it. Students reconnect on their own; a restarted gateway deletes its own leftover connection
keys at boot, so nobody is locked out (log line `sse: deleted connection keys left by a previous
run`).

## 3. Are events being produced?

```bash
redis-cli XLEN stream:events                        # growing while buses run
redis-cli XREVRANGE stream:events + - COUNT 3       # recent bus.position frames
redis-cli XINFO GROUPS stream:pings                 # geo group: pending should be ~0
```

- `stream:events` not growing but `stream:pings` is: the **engine** is down or its geo consumer
  is stuck. Check the engine log for `geo: batch failed`; restart it. It resumes mid-trip from
  `trip:{id}:geo`.
- Neither growing: nothing is being ingested. That is `bus-not-appearing.md`.

## 4. "Reconnecting…" for one student

```bash
redis-cli --scan --pattern "sse:conn:<userId>:*"    # at most 3; each value names its gateway
```

- Three keys and the student has fewer than three tabs open: phantom connections from a gateway
  that died and did not come back under the same instance id. They expire within **45 s** on
  their own (TTL keys, invariant 10). If one must be cleared by hand: `redis-cli DEL <key>`.
  **Never** convert these to a SET: that is the permanent lockout the design exists to prevent.
- No keys and still reconnecting: the token is failing. The client fetches a fresh one per
  attempt; a signed-out session shows the login page on next navigation.

## 5. Everyone sees buses turn amber at the same time

That is a *real* missed-ping signal across the fleet, or the engine's sweeper judging against a
clock that jumped. Check that pings are arriving (`XLEN stream:pings` growing) and that the
engine host's clock is correct (`date -u`). Amber is decided from each fix's age against the
cadence it reported: 3× (15 s moving, 45 s parked).

## Prevention

- The Stage 3 harnesses (`tests/e2e/live-map.ts`, `tests/e2e/resilience.ts`) reproduce this
  page's failures deliberately; run them after any change to the gateway stream or the client.
- Watch `sse` connection count and `stream:events` consumer lag on the Stage 8 dashboards.
