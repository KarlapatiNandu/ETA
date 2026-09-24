# ADR-0007 — Confirmed sends and doorbells: the server checks the count, the row is the outbox

**Status:** accepted · **Stage:** 7 · **Date:** 2026-09-24

## Context

Invariant 11: nothing reaches student phones without a rendered preview, a resolved recipient
count and an explicit confirmation. The admin console is the only place a human can make the
system buzz hundreds of phones, and ARCH §1 names the failure outright: a TD mistake that
"buzzes 300 phones with garbage" costs institutional trust that does not come back.

Two design questions follow, and both were close.

1. **Where is the confirmation enforced?** A confirmation dialog in the browser is easy. It is
   also bypassable (a stale tab, a double submit, a script) and it can be *wrong*: the number on
   the dialog was true when the dialog opened, not when the admin clicked.
2. **How does a committed admin action reach the notify worker (Stage 6)?** The action is a
   database transaction; the worker consumes `stream:notify`. The two cannot be written
   atomically.

## Options considered — enforcement

- **A. UI-only confirmation.** Rejected: the invariant becomes a property of one React component.
- **B. A server-side "confirm token"** issued with the preview and redeemed on send. Stops
  replays, but not a count that moved in between, and it adds state to the gateway.
- **C. The request carries the count it was shown; the gateway re-resolves and compares
  (chosen).** `confirm_count` must equal the audience resolved at send time (`409 count_changed`
  with the new number otherwise, `428` when missing). A T0 additionally needs the number typed
  out (`confirm_text`), because typing a number forces reading it and "yes" does not. The
  resolver is the same function the notify worker fans out with
  (`apps/engine/src/lib/audience.ts`), so the confirmed number and the delivered audience agree
  by construction.

## Options considered — delivery

- **A. XADD inside the transaction, before COMMIT.** Rejected after thinking it through: the
  worker's blocking read can see the doorbell before the commit is visible, find no row, and drop
  a real notification.
- **B. A transactional outbox table plus a relay process.** Correct, and the textbook answer,
  but a new table, a new process and a new lag for a flow that already has a natural outbox.
- **C. The row is the outbox; `stream:notify` is a doorbell (chosen).** Commit the row
  (announcement with `published_at`, ticket, applied upload), then append `{type, id}`. The
  worker reads the truth from the row, drops a doorbell whose row does not exist, and — in Stage
  6 — sweeps for rows that were published but never delivered, which covers a doorbell lost to a
  Redis failure between commit and XADD. The doorbell failing after commit is logged, never an
  error to the admin: the change has happened.

## Consequences accepted

- Every notifying endpoint has a two-step conversation (preview → confirm), and an admin whose
  audience changed mid-dialog is asked again. That is the point, but it is friction.
- A scheduled announcement's cohort/route/bus audience is resolved when it is *sent*, not when it
  was confirmed; `confirmed_count` records what the admin agreed to. A custom list is frozen at
  confirm time in `announcement_recipients`.
- Delivery is at-least-once from the doorbell's side. Exactly-once is the database's job
  (`notification_recipients.dedupe_key`, invariant 5), as everywhere else in the spine.
- Stage 6 must implement the sweep, or a Redis blip at the wrong moment delays a notification
  indefinitely. It is carried forward in `tracker.md` and M07.
