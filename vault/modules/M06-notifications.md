---
stage: M06
title: Notification spine
status: in-progress
started: 2026-09-24
completed: —
---

# M06 — Notification spine

## Summary

Students are now told. A student can turn alerts on for their phone, star buses and pick one as
*their* bus, and receive the Stage 6 wiring table:
- their bus starting (T1)
- a starred bus starting (T3, with *Follow* / *Not today* buttons)
- stop-by-stop progress collapsed into one updating notification
- "leave now"
- signal lost (T2, or T4 in a known dead zone)
- a bus out of commission (T0, plus SMS) and back in service (T2)
- the Transport Department's announcements and event-day lists

The notification center holds every one of them, written even when no transport works. A kill
switch, per-bus mute, quiet hours, a maximum tier and a critical-breakthrough setting are all in
Settings.

Every adversarial test in the build plan passes. Push works end to end through Google's push
service into a real browser, with **p95 2.4 s** from event to push. Three things keep this stage
from being complete:
- **Needs a person:** iOS push on a physical iPhone, and "phone buzzes" latency on a real phone.
- **Needs DLT approval:** real SMS.
- **Needs real buses:** the build plan says Stage 6 does not start before Stage 5's real-bus ETA
  gate. It was built ahead of that gate against simulated and recorded data, on the owner's
  instruction (2026-09-23), and cannot be marked complete before the gate is met.

## Scope delivered

- [x] VAPID keys (`pnpm --filter @busmitra/notify vapid`); service worker `push` +
      `notificationclick` (`apps/web/public/sw.js`); web app manifest and icons
- [x] Subscription lifecycle + health: subscribe/re-send on every visit, 404/410 prune, 429
      back-off, `failure_count ≥ 5` unhealthy
- [x] iOS install-prompt UX: iOS Safari without `standalone` is shown the Share → Add to Home
      Screen steps, and told urgent alerts come by SMS meanwhile
- [x] MSG91 SMS adapter with T0/T1 templates and **delivery receipts** (webhook, token-guarded)
- [x] `engine/notify.ts`: event → plan → record → filters → channel → send → receipt
- [x] Synchronous SMS fallback on the push POST's status (T0 always, T1 on failure)
- [x] Parent + recipients in one transaction; `source_key` + `dedupe_key`; collapse tags
- [x] Event wiring table: trip start T1/T3, stop reached (T3, collapsed), leave now (T1), signal
      lost T2 / known zone T4 (+ T3 on recovery), out of commission T0 / back T2, announcements,
      event-day lists
- [x] Notification actions: *Follow* (subscribes to the route stop nearest the student's pin),
      *Not today* (mutes until 23:59 IST, keeps the star)
- [x] Notification center: tier filter, unread, ticket cards with live status, T0
      acknowledgement, paging; in-app banner for arrivals while the app is open; bell badge
- [x] Kill switch ("I'm on the bus", 3 h, capped at midnight IST, boards today's trip), per-bus
      mute, quiet hours (start + duration, wraps midnight), maximum tier, T0 breakthrough
- [x] Carried forward from Stage 7 and done: deliver the admin console's doorbells; the sweep for
      rows published but never delivered (ADR-0007, including leave-now); the starring UI;
      `ticket.update` frames; delivery counts on the admin's announcement list

**Deliberately not done, and why:**
- **Offline caching (Serwist)** — ARCH §2.1 names Serwist for the offline shell as well as push.
  Push needs neither Serwist nor a build step, so `sw.js` is plain JavaScript that does push only.
  The offline shell is carried forward.
- **Announcement attachments** — still carried forward (no exit criterion needs them).
- **Translating the driver app** (carried from Stage 2 "before the pilot") — carried to Stage 9,
  where the pilot is.

## Components added

| Path | What it is |
|---|---|
| `packages/db/migrations/0008_notifications.sql` | `notifications` (+ `source_key`), `notification_recipients` (+ `deliver_after`, `sent_at`, `provider_ref`), `push_subscriptions` (+ `backoff_until`), `announcements.notification_id` FK, `notification_delivery()`, RLS, retention cron |
| `packages/notify/src/tiers.ts` | tier behaviour, `decide()` (the §6.3 filters), quiet hours, `dedupeKey`, operating day |
| `packages/notify/src/push.ts` | Web Push via `web-push` (VAPID), status-only result |
| `packages/notify/src/sms.ts` | T0/T1 templates, request id as `ref` |
| `packages/notify/src/cli/vapid.ts` | key-pair generator |
| `apps/engine/src/lib/notify-plans.ts` | event → plan (the wiring table) |
| `apps/engine/src/workers/notify.ts` | record, deliver, recover; two stream consumers and the delivery loop |
| `apps/gateway/src/routes/api/notifications.ts` | push subscriptions, center, actions, favourites, kill switch, preferences, SMS receipt webhook |
| `apps/gateway/src/routes/stream/index.ts` | `pubsub:notify` → per-user frames |
| `apps/web/public/sw.js`, `app/manifest.ts`, `public/icons/*`, `apple-touch-icon.png` | the PWA surface push needs |
| `apps/web/lib/push.ts`, `lib/store/inbox.ts` | subscription lifecycle, the live badge |
| `apps/web/components/notifications/*`, `app/(student)/notifications/page.tsx` | bell, banner, push setup, pause, favourites toggle, alert settings, center |
| `tests/e2e/stage6.ts` | real push in a browser, timed |

## Files changed

The tree is uncommitted (start commit `9cabdb2`), so this list is compiled from the stage's
edits rather than `git diff`.

| Status | Path | What changed and why |
|---|---|---|
| added | `packages/db/migrations/0008_notifications.sql` (+ mirror), `packages/db/src/notifications.test.ts` | schema; dedupe + RLS A-vs-B (recipients, push subscriptions) |
| added | `packages/notify/src/{tiers,tiers.test,push}.ts`, `src/cli/vapid.ts` | tiering, filters, push |
| modified | `packages/notify/src/{sms,index}.ts`, `package.json` | alert templates, refs; `web-push`; `vapid` script |
| modified | `packages/config/src/env.ts`, `.env.example` | `notifyEnv` (VAPID pair, subject, receipt token), `MSG91_TEMPLATE_T0/T1` |
| modified | `packages/contracts/src/notify.ts` | `trip_start`, `UserFrames`, student API schemas, `NotificationItem` |
| modified | `packages/redis/src/keys.ts` | `pubsub:notify`, group `notify` |
| added | `apps/engine/src/lib/notify-plans.ts`, `apps/engine/src/workers/{notify,notify.test}.ts` | the spine + 14 adversarial tests |
| modified | `apps/engine/src/lib/audience.ts`, `src/main.ts`, `package.json` | `sql` audience; worker wiring; `@busmitra/notify` |
| added | `apps/gateway/src/routes/api/{notifications,notifications.test}.ts` | student API + webhook |
| modified | `apps/gateway/src/{app,server,testing}.ts` | registration, env, receipt token for tests |
| modified | `apps/gateway/src/routes/stream/{index,stream.test}.ts` | per-user frames |
| modified | `apps/gateway/src/routes/tracker/{index,tracker.test}.ts` | `trip_start` doorbell on a new trip only |
| modified | `apps/gateway/src/routes/api/admin/announcements.ts`, `apps/web/app/(admin)/admin/announcements/page.tsx` | delivery counts |
| added | `apps/web/public/{sw.js,icons/*,apple-touch-icon.png}`, `app/manifest.ts`, `lib/{push.ts,store/inbox.ts}`, `components/notifications/*`, `app/(student)/notifications/page.tsx` | web |
| modified | `apps/web/app/{layout.tsx,(student)/layout.tsx,(student)/page.tsx,(student)/settings/page.tsx}`, `components/live/{bus-sheet,use-live-stream}.tsx`, `middleware.ts` | bell, banner, pause, push setup, favourites, alert settings; SSE → inbox; PWA assets bypass auth middleware |
| added | `tests/e2e/stage6.ts` | browser run |
| modified | `docs/SCHEMA.md`, `docs/ARCHITECTURE.md` | §6 as built, §10 `pubsub:notify`, tag format |
| added | `vault/decisions/ADR-0004-tiering-and-dedupe.md`, `vault/runbooks/push-not-delivering.md`, `vault/benchmarks/alert-latency-v1.md`, this file | ritual |

## Schema changes

| Migration | Change | Reversible? |
|---|---|---|
| `0008_notifications.sql` | tables, FK, function, RLS, cron above | yes, with data loss — see Rolling back |

## Configuration

| Variable | Purpose | Where to obtain | Secret? |
|---|---|---|---|
| `VAPID_PUBLIC_KEY` | Web Push application server key (gateway publishes it; engine signs with the pair) | `pnpm --filter @busmitra/notify vapid`, once per environment | no |
| `VAPID_PRIVATE_KEY` | the pair's private half — engine and gateway | same | **yes** |
| `VAPID_SUBJECT` | contact the push services require (`mailto:`/`https:`) | the TD's transport mailbox | no |
| `MSG91_TEMPLATE_T0`, `MSG91_TEMPLATE_T1` | DLT-approved alert templates (`##title##`, `##body##`) | MSG91 after DLT approval | no |
| `SMS_RECEIPT_TOKEN` | guards `POST /v1/notify/sms-receipt?token=…` | `openssl rand -hex 16`; paste the URL into MSG91 | **yes** |

Rotating the VAPID pair invalidates every subscription: students must turn alerts on again.

## Technical decisions

- **Exactly-once record, at-most-once transport** — full ADR:
  `vault/decisions/ADR-0004-tiering-and-dedupe.md`.
- **Filters decide the channel, never the record.** A paused, muted, quiet or over-tier student
  still gets the center entry (`inapp_only` + reason).
- **Freshness per event.** Time-critical events have a shelf life (leave-now 2 min, trip start
  5 min, broadcast progress/signal 2 min — the latter not recorded at all when stale), admin sends
  12 h, an open T0 none. Rejected: one global cut-off (either a cancellation stops buzzing after
  an engine restart, or yesterday's "leave now" buzzes this morning).
- **Trip start is a doorbell from the driver's START**, not inferred from pings: buffered pings
  can never produce it, and a resume never rings it.
- **Delivery loop woken by the recorders**, polled every 1 s otherwise (quiet hours come due on
  the clock). Rejected: BullMQ per send — a queue per student send adds nothing the claim-based
  loop does not already give, and the ARCH §2.1 "never inline on a request" rule is met (the
  gateway only rings doorbells).
- **Collapse tags use hyphens** (`trip-{id}-progress`): the key-registry guard (invariant 15)
  flags anything shaped like a Redis key, and a tag is not one. ARCH §6.1 updated.
- **Follow picks the route stop nearest the student's pin**, and asks for a pin if there is none,
  rather than guessing.
- **Plain-JS service worker** for push only; Serwist's offline shell is a separate job.

## Gotchas and failure modes

- **Symptom:** after the first engine start with the notify worker, "Bus SIM-07 is out of
  commission" went out by SMS for a ticket resolved the day before.
  **Cause:** the new consumer group read `stream:notify` from the beginning, including the Stage 7
  browser run's doorbells; a ticket doorbell had no shelf life.
  **Fix:** an "opened" doorbell for a ticket that is no longer open is center-only; admin sends
  older than 12 h are center-only. **Prevention:** test "a ticket resolved before its doorbell was
  processed buzzes nobody". (It was the console SMS provider; nothing real was sent.)
- **Symptom:** the Redis key-registry test failed on `notify-plans.ts`.
  **Cause:** Web Push tags written `trip:{id}:progress`, which is Redis-key-shaped.
  **Fix:** hyphenated tags. The guard was right to flag it; it was not weakened.
- **Symptom:** `TripStarted` export collision in contracts. **Fix:** `TripStartEvent`.
- **Symptom:** `inconsistent types deduced for parameter $1` (PGlite).
  **Cause:** one parameter used as `uuid` and concatenated as `text` in the same statement (a test).
  **Fix:** pass the two values separately.
- **Symptom:** MSG91 receipts parsed as zero reports. **Cause:** the status sits in a nested
  per-number report, not beside `requestId`. **Fix:** look one level down.
- **Symptom:** one 13.6 s push in the first browser run (p95 otherwise < 0.6 s).
  **Cause:** not established; most likely the push service. **Prevention:** v2 of the benchmark
  should record the engine's POST time per notification.
- **Watch for:** the same consumer-group-from-zero effect applies to `stream:events`
  (`XINFO GROUPS` shows `notify` starting at 0). Broadcast events older than 2 min are dropped
  unrecorded, so it is harmless — but a fresh environment with a full stream spends its first
  pass reading and dropping them.
- **Watch for:** headless Chrome gets a real FCM subscription, so the browser run needs internet
  and sends real (harmless) pushes to Google.

## Verifying locally

```bash
pnpm --filter @busmitra/notify vapid >> .env            # once
npx supabase migration up --workdir infra --local        # applies 0008 on a running stack
pnpm dev
pnpm test                                               # 503 tests
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  npx vitest run packages/db apps/engine/src/workers/notify.test.ts apps/gateway/src/routes/api
# real push, timed (needs internet, a claimed student, an admin token):
E2E_PASSWORD=… E2E_ADMIN_TOKEN=… node --experimental-strip-types tests/e2e/stage6.ts --n 40
```

Expected browser report: `pushState: "on"`, `eventToPushMs.p95` a few seconds at most,
`criticalStillNeedsAck: false` after "I understand", `pause: "Alerts paused until …"`,
`pageErrors: []`.

## Performance

| Metric | Target | Measured | Conditions |
|---|---|---|---|
| Event → push received by the browser, p95 | < 10 s to the phone | **2.4 s** (p50 590 ms) | n = 40, local stack, FCM, headless Chrome |
| 600 students, one T0 | all within 30 s | **0.55 s** | Postgres 15, 20 ms push stub (0.31 s on PGlite) |
| Restart mid-fan-out | zero duplicates | **0 duplicates**, 86/86 center rows | 80 + 6 students, killed after 30 sends |

Details: `vault/benchmarks/alert-latency-v1.md`.

## Rolling back

```sql
ALTER TABLE announcements DROP CONSTRAINT IF EXISTS announcements_notification_id_fkey;
UPDATE announcements SET notification_id = NULL;
DROP FUNCTION IF EXISTS notification_delivery(uuid);
DROP TABLE IF EXISTS notification_recipients, notifications, push_subscriptions CASCADE;
SELECT cron.unschedule('purge-notifications');   -- where pg_cron exists
DELETE FROM supabase_migrations.schema_migrations WHERE version = '0008';
```

This loses every student's notification history and push subscription (they re-enable alerts).
Stop the engine first, or the notify worker will fail every batch until the code is reverted too.

## Carried forward

- **Stage 6 exits needing people or approvals:**
  - 👥 iOS: an installed PWA receives push; an uninstalled iPhone gets SMS for T0/T1 — needs an
    iPhone (and, for the SMS half, DLT)
  - 👥 event → **phone** buzzes, p95 < 10 s — needs a physical phone on cellular (the pipeline to
    the browser is measured: 2.4 s)
  - DLT + `MSG91_TEMPLATE_T0/T1` for real SMS; configure the receipt webhook URL in MSG91
  - the Stage 5 ETA soak gate (≥ 10 real trips), which the build plan puts before Stage 6
- **Stage 8:** the 600-client k6 run should use a real push service (or a realistic stub
  latency); record the engine's POST time per notification (benchmark v2); `notify` consumer lag
  on the observability page; alert on push failure rate > 10 %.
- **Stage 9:** translate the driver app and the student notification copy; the Serwist offline
  shell; production VAPID keys generated once and stored as secrets.
- **Later:** announcement attachments; a per-user body for stop progress ("3 stops to yours").
