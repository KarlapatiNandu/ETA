# Push not delivering

**Symptom:** a student says "I didn't get the alert" — for a leave-now, a bus that started, a
cancelled bus, or an announcement. Or the admin console shows an announcement with many
"in-app only" and few "pushed".

The first question is always: **is it in their notification center?** The center is written for
every student in the audience, whether or not any transport worked (invariant 14). If it is there,
the spine decided correctly and the question is only *why that channel*. If it is not there, the
student was not in the audience, or the event never reached the worker.

> Dev: `DB` = `docker exec supabase_db_busmitra psql -U postgres -d postgres`,
> `R` = `docker exec busmitra-redis-1 redis-cli`. Production: the Supabase SQL editor and the
> Redis console.

---

## 1. Find the student's row

```sql
-- DB: the student's last alerts, with the channel and the reason
SELECT n.source_key, n.tier, n.title, r.channel, r.failure_reason,
       r.queued_at, r.deliver_after, r.sent_at, r.delivered_at, r.read_at
  FROM notification_recipients r JOIN notifications n ON n.id = r.notification_id
  JOIN profiles p ON p.id = r.user_id
 WHERE p.roll_no = '160125737001'
 ORDER BY r.queued_at DESC LIMIT 20;
```

Read `channel` and `failure_reason`:

| `failure_reason` | Meaning | What to do |
|---|---|---|
| `paused` | The student pressed "I'm on the bus" (kill switch) | Nothing — working as designed. It clears after 3 h or at midnight |
| `muted` | "Not today" on that bus | Nothing; it clears at midnight |
| `above_max_tier` | The student chose fewer alerts in Settings | Nothing |
| `tier_4` | An ambient (in-app only) notification | Nothing — T4 never buzzes |
| `late` | The event was too old to be news when the worker saw it (engine down, a replay) | Check §4 — why was it late? |
| `expired` | Deferred (quiet hours) or queued past its useful life | Nothing |
| `quiet_hours` (with `sent_at` NULL) | Waiting for the end of the student's quiet hours | Nothing; `deliver_after` says when |
| `no push subscription` | This student has never turned alerts on, on any device | Ask them to open Settings → Alerts → Turn on alerts (on iPhone: from the Home Screen app) |
| `push 404/410: subscription removed` | The browser dropped the subscription (uninstalled, cleared data, revoked permission) | Same as above; T0/T1 went by SMS |
| `push 429: backing off` | The push service is rate-limiting us | Transient; see §3 if widespread |
| `push 500` / `push network error` | The push service failed | §3 |
| `push not configured` | The engine has no VAPID keys | §2 |
| `sms: …` | The SMS fallback failed too | §5 |

`channel = sms` with an empty `delivered_at` means MSG91 accepted it but no delivery receipt has
arrived yet (§5).

## 2. Nobody gets push at all

```bash
curl -s <gateway>/v1/push/config -H "authorization: Bearer <any student token>"
# {"publicKey": null}  → the gateway has no VAPID_PUBLIC_KEY
```

- Set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` on **both** gateway and engine (the same pair),
  and `VAPID_SUBJECT`. Generate with `pnpm --filter @busmitra/notify vapid` — **once**: a new pair
  invalidates every existing subscription and every student must turn alerts on again.
- Check the engine log for `notify: delivered` lines. None at all → §4.

## 3. The push service is failing

```sql
-- DB: last hour, by outcome
SELECT r.channel, split_part(r.failure_reason, ';', 1) AS reason, count(*)
  FROM notification_recipients r WHERE r.queued_at > now() - interval '1 hour'
 GROUP BY 1, 2 ORDER BY 3 DESC;
-- subscriptions marked unhealthy (5+ failures) — no longer tried until the student re-enables
SELECT count(*) FILTER (WHERE failure_count >= 5), count(*) FROM push_subscriptions;
```

A spike of `push 5xx` for every student is the push service (FCM / Mozilla / Apple), not us: T0
and T1 are already going by SMS. A spike of `404/410` right after a VAPID change is expected
(§2).

## 4. Nothing is being recorded

The worker records from two streams, consumer group `notify`:

```bash
R XINFO GROUPS stream:notify        # doorbells: leave_now, announcement, ticket, event_day, trip_start
R XINFO GROUPS stream:events        # stop.reached and bus.status, group "notify"
R XPENDING stream:notify notify     # entries delivered but not acknowledged: a stuck worker
```

- `pending` growing → the worker is failing each batch; the engine log says why (`notify: batch
  failed, retrying`). Usually Postgres.
- `lag` growing with `pending` 0 → the engine is not running.
- An admin send with no doorbell at all is recovered by the worker's sweep within ~30 s (ADR-0007):
  look for `notify: recovered lost doorbells` in the log.

## 5. SMS

- `SMS_PROVIDER=console` → SMS is printed to the engine log, never sent. Real SMS needs DLT
  approval and `MSG91_TEMPLATE_T0` / `MSG91_TEMPLATE_T1` (docs/OUTREACH.md §1).
- `sms: no DLT template configured for t1_alert` → the template id is not set.
- Delivery receipts arrive at `POST /v1/notify/sms-receipt?token=<SMS_RECEIPT_TOKEN>`; configure
  that URL in the MSG91 dashboard. Without it `delivered_at` stays empty for SMS (the message may
  still have arrived).

## 6. iPhone

iOS delivers Web Push only to the app **added to the Home Screen** (Safari 16.4+), never to a
Safari tab. The app detects this and shows the student how to install; until they do, their T0/T1
alerts come by SMS and everything else is in-app only. There is no server-side fix.

## Prevention

- `apps/engine/src/workers/notify.test.ts` — restart mid-fan-out, flapping geofence, skipped stop,
  replayed backfill, 600-student T0, revoked push → SMS, kill switch, every transport failing,
  quiet hours, stale tickets.
- `tests/e2e/stage6.ts` — a real browser subscription through Google's push service, timed.
