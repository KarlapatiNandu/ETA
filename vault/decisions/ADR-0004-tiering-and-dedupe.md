# ADR-0004 — Tiering and dedupe: the record is exactly-once, the transport is at-most-once

**Status:** accepted · **Stage:** 6 · **Date:** 2026-09-24

## Context

ARCHITECTURE §1 names two failures that end the product: a student told the same thing twice (or
twelve times for twelve stops) disables notifications for good, and a student told late misses
the bus. The spine has to survive every ordinary fault — a worker restarted mid-fan-out, a
retried stream batch, a geofence flapping, a day of buffered pings flushed at once, a push service
returning 410 — without doing either.

Three things had to be decided: where "exactly once" lives, what a transport failure does, and
how a push that cannot be delivered falls back to SMS.

## Options considered — exactly once

- **A. Application-level checks** ("have I sent this?") in the worker. Rejected: this is the
  logic that fails at 7:40 a.m. (ARCH §6.2), and it races with itself across two workers.
- **B. An outbox table per transport**, with a relay. Correct but heavy, and it still needs an
  idempotency key per student.
- **C. Keys in the database (chosen).** `notifications.source_key` makes the *event* idempotent
  (a replay finds its parent), `notification_recipients.dedupe_key = sha256(user | event type |
  bus | stop | service date | source)` makes the *student* idempotent. The parent and all
  recipients commit in one transaction, so there is never an orphan parent. This is the
  notification center, and it is exactly-once.

## Options considered — the transport

- **A. At-least-once sends**: claim, send, mark done; re-send anything not marked after a
  timeout. A worker killed after the push service accepted the message but before the mark
  re-sends it — the duplicate the exit criterion forbids.
- **B. At-most-once sends (chosen).** A recipient row is claimed by `UPDATE … SET sent_at = now()
  WHERE sent_at IS NULL` *before* the send and never claimed again. A crash between the claim and
  the send costs that one student that one buzz; the center still has the entry, and the app's
  badge still shows it. The exit criterion is "zero duplicates", and a lost buzz with a recorded
  entry is the recoverable failure of the two.

## Options considered — push → SMS

- **A. Wait for a delivery signal, then fall back.** Web Push has no delivery receipt: `201`
  means the push *service* accepted it (ARCH §6.3). Any wait spends the 10 s budget to learn
  nothing.
- **B. Decide on the POST's own status, synchronously (chosen).** T0 always also goes by SMS; T1
  goes by SMS when no subscription accepted it (none, all unhealthy, 404/410, 5xx, network).
  404/410 delete the subscription; 429 backs it off for 60 s; other failures count towards
  `failure_count ≥ 5` = unhealthy.

## Consequences accepted

- A worker crash mid-fan-out can leave some students without the buzz for that one
  notification (never with two). Measured by the restart test: 80 students, the worker killed
  after 30 sends, restarted — no student got two pushes, all 86 have their center row.
- Per-user filters (kill switch, "not today", `max_tier`, quiet hours, freshness) change the
  *channel*, never the record: suppressed students still see the entry in the app.
- Admins can see counts (`notification_delivery()`), never who.
- The collapse tag keeps a trip's stop progress to one notification on the phone, but the center
  keeps every stop as its own row — the history is the record.
