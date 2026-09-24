---
stage: M07
title: Admin console
status: in-progress
started: 2026-09-23
completed: —
---

# M07 — Admin console

## Summary

The Transport Department can now run the fleet from a browser. A TD member can add buses and
drivers, pair a driver's phone by QR code, rotate or revoke its secret, mark a bus out of
commission (a T0 to everyone connected to it) and return it to service from its ticket (a T2 on
the same ticket). They can work a ticket queue with a timeline, write an announcement to a cohort,
a route, a bus or a pasted list of students, publish an event-day bus list from a spreadsheet,
watch the live fleet, and read an audit log of every change. At every step that would notify
anyone, the console shows the rendered notification and the exact number of students it will
reach. **The gateway refuses the send if that number is missing, stale, or (for T0) not typed out.**

Every build item and every exit criterion that code can meet is done, tested on PGlite and on
real Supabase Postgres 15, and driven in a real browser. One exit criterion needs people: a
usability session with a non-technical TD member. That is why this entry says *in-progress*.

## Scope delivered

- [x] Fleet management: bus CRUD (archive, not delete), driver records and assignment, route
      assignment, tracker **pairing with a one-time QR code**, secret rotation, unpairing
      (revokes the secret)
- [x] Out of commission → ticket → **T0** (typed count confirmation); resolve → **T2** on the
      same ticket, bus back to `active`. Back in service is possible *only* through the ticket.
- [x] Announcements: composer with a plain-language tier explainer, audience selector (All /
      Juniors / Seniors / Route / Bus / Custom → `announcement_recipients`), live recipient count
      (with unmatched roll numbers listed), send now or schedule (cancellable until sent), and a
      count-stating confirmation
- [x] Event-day CSV: parse → validate against the fleet and published routes → rendered diff
      (added / changed / removed / unchanged) → confirm the number → apply → a doorbell for the
      cohort-segmented T2. `content_hash` flags an identical re-upload, and an apply that changes
      nothing notifies nobody.
- [x] Ticket queue: open / acknowledged / resolved / cancelled, assignment, notes, timeline, and
      **auto-opened signal-loss tickets** (engine, 5 min outside a known dead zone, self-resolving)
- [x] Live fleet dashboard: presence, last-ping age with cadence, current trip, today's ETA
      accuracy (10-minute horizon MAE), open tickets
- [x] Audit log viewer: filter by entity, hide the system's own writes, before/after per changed
      field, keyset paging
- [x] Carried forward and done: stop management (rename / aliases / area / landmark; move and
      archive refused for a stop a published route uses), explicit roster removal (unclaimed
      only), tracker pairing screen with QR, the 60-second rotation lag (re-read on signature
      miss), `scheduled` trips from today's event-day list, favourites A-vs-B RLS cases,
      light-theme admin shell (checked in the browser: clean)

**Deliberately not done, and why:**
- **Delivering** any notification is Stage 6. Stage 7 commits the row and rings `stream:notify`
  (ADR-0007); nothing buzzes yet.
- Announcement **attachments** (`attachment_path`): not in any exit criterion, and it needs the
  Storage upload path plus a student-side viewer. Carried forward to Stage 6 (the notification
  centre renders it).
- Regular **timetables** (non-event days): there is no timetable table in SCHEMA; `scheduled`
  trips come only from event-day lists. Carried forward.
- **Supabase Realtime** for admin state (ARCH §2.2 allows it): the console polls instead
  (dashboard 5 s, tickets 15 s). Cheaper to build, one fewer moving part, and latency does not
  matter here.

## Components added

| Path | What it is |
|---|---|
| `packages/db/migrations/0007_admin_console.sql` | `drivers`, `buses.driver_id`, `favourites`, `tickets` (+ `assigned_to`), `ticket_events`, `announcements` (+ `confirmed_count`, `scheduled_for`, `cancelled_at`), `announcement_recipients`, `event_day_buses`; audit triggers; RLS |
| `packages/contracts/src/admin.ts` | tiers in plain language, `Confirmation`, fleet/driver/ticket/announcement/audience schemas, the event-day CSV parser (`parseEventDayCsv`, `parseClock`) |
| `packages/contracts/src/notify.ts` | `NotifyEvent`: the `stream:notify` union (`leave_now`, `announcement`, `ticket`, `event_day`) |
| `packages/redis/src/events.ts` `ringNotify` | append doorbells to `stream:notify` |
| `apps/engine/src/lib/audience.ts` | the one audience resolver (all / cohorts / route lineage / bus / users / saved custom list) |
| `apps/engine/src/workers/event-day.ts` | resolve against the fleet, diff, apply (cohort-scoped replace, no-op for unchanged rows, cancels stale scheduled trips) |
| `apps/engine/src/workers/schedule.ts` | today's event-day rows → the next `scheduled` trip per bus; abandons unstarted ones after 2 h |
| `apps/engine/src/workers/tickets.ts` | automatic signal-loss tickets, self-resolving |
| `apps/engine/src/workers/announcements.ts` | publishes due scheduled announcements (compare-and-set) |
| `apps/engine/src/lib/ticker.ts` | the shared periodic-job loop |
| `apps/gateway/src/routes/api/admin/{fleet,tickets,announcements,event-day,audit,dashboard,common}.ts` | the console's API; `common.ts` holds `checkConfirmation` and `ring` |
| `apps/web/app/(admin)/admin/{page,fleet,fleet/[id],tickets,tickets/[id],announcements,event-day,stops,audit}` | the console |
| `apps/web/components/admin/confirm-send.tsx` | the one confirmation dialog: rendered notification, stated count, typed T0 count, re-asks on `count_changed` |
| `apps/web/lib/admin.ts` | client for `/v1/admin/*` that keeps error codes and bodies |
| `tests/e2e/stage7.ts` | the three core workflows in headless Chrome |

## Files changed

The tree is uncommitted (start commit `9cabdb2`), so this list is compiled from the stage's
edits rather than `git diff`. Everything under `apps/`, `packages/` and `tests/` is untracked
relative to `9cabdb2`.

| Status | Path | What changed and why |
|---|---|---|
| added | `packages/db/migrations/0007_admin_console.sql` (+ mirror in `infra/supabase/migrations/`) | schema above |
| added | `packages/db/src/admin.test.ts` | constraints, RLS (favourites A-vs-B; admin-only tables; students read tickets, never write), audit |
| added | `packages/contracts/src/{admin,admin.test,notify}.ts` | contracts first |
| modified | `packages/contracts/src/index.ts` | exports |
| modified | `packages/contracts/src/routes.ts` | `StopSearchHit` gains optional `aliases`, `landmark` (stop form must not wipe them) |
| modified | `packages/redis/src/events.ts` | `ringNotify` |
| added | `apps/engine/src/lib/{audience,ticker}.ts`, `apps/engine/src/workers/{event-day,schedule,tickets,announcements,admin.test}.ts` | engine half |
| modified | `apps/engine/src/main.ts`, `apps/engine/package.json` | three periodic jobs; exports |
| added | `apps/gateway/src/routes/api/admin/{common,fleet,tickets,announcements,event-day,audit,dashboard,console.test}.ts` | API + 15 HTTP tests |
| modified | `apps/gateway/src/app.ts` | registers the routes; one tracker directory shared by ingest and the console |
| modified | `apps/gateway/src/services/trackers.ts` (+ test), `plugins/device-auth.ts` | `refresh()`: re-read once on a signature miss, ≤ 1 query / 5 s / device |
| modified | `apps/gateway/src/routes/api/admin/roster.ts` (+ test) | `DELETE /v1/admin/roster/students/:rollNo` (unclaimed only) |
| modified | `apps/gateway/src/routes/api/admin/routes.ts` (+ test) | `PATCH /v1/admin/stops/:id`, `POST …/archive`, guarded; stop search returns aliases/landmark |
| added | `apps/web/lib/admin.ts`, `apps/web/components/admin/{confirm-send.tsx,types.ts}`, 8 admin pages | console UI |
| modified | `apps/web/app/(admin)/admin/{layout,page}.tsx` | navigation; the home page is now the live fleet dashboard |
| modified | `apps/web/package.json`, `pnpm-lock.yaml` | `qrcode` (+ `@types/qrcode`) |
| added | `tests/e2e/stage7.ts` | browser run |
| modified | `docs/SCHEMA.md` | §2 drivers, §5 favourites in 0007, §6 tickets/announcements as built, §7 event-day as built, §9 RLS rows, §10 `stream:notify` doorbells |
| modified | `docs/ARCHITECTURE.md` | §6.3 as built (confirmation + doorbells), §5.7 signal-loss tickets as built |
| added | `vault/decisions/ADR-0007-confirmed-sends-and-doorbells.md`, `vault/runbooks/csv-upload-failed.md`, this file | ritual |
| modified | `tracker.md`, `vault/README.md`, `README.md` | indices |

## Schema changes

| Migration | Change | Reversible? |
|---|---|---|
| `0007_admin_console.sql` | tables, `buses.driver_id`, indexes, audit triggers, RLS as above | yes, but it drops data — see Rolling back |

## Configuration

No new environment variables. Pairing links use the existing `DRIVER_ORIGIN`; tracker secrets
use the existing `TRACKER_SECRET_KEY`.

## Technical decisions

- **The server enforces the confirmation; the row is the outbox; `stream:notify` is a doorbell.**
  Contested, so it is a full ADR: `vault/decisions/ADR-0007-confirmed-sends-and-doorbells.md`.
- **One audience resolver in the engine**, imported by the gateway. The confirmed number and the
  fanned-out audience cannot drift apart. Rejected: counting in SQL in the gateway and resolving
  separately in the worker (two definitions of "connected to a bus").
- **"Connected to a bus" = favourited it, or following one of its trips today** (ARCH §6.4). A
  route audience is its *lineage*: all versions, and buses assigned to any of them.
- **Favourites created in 0007**, a stage early: the audience count needs the table. The
  starring UI is still Stage 6.
- **Out of commission can only be undone by resolving its ticket**, and that ticket cannot be
  cancelled: the only way back tells the students who were warned.
- **Event-day upload scope = the cohorts its rows mention.** Rejected: a file replaces the whole
  day (a seniors-only correction would wipe the juniors' list), or a form-level cohort that
  overrides rows (the TD's sheets mix both).
- **An apply that changes nothing notifies nobody**, in addition to the `content_hash` notice.
  The hash alone would miss "same content, different file" edge cases (a re-saved sheet with a
  trailing newline); the diff does not.
- **Scheduled trips are materialised on the service day, one per bus**, because `one_live_trip`
  counts `scheduled` and a trip scheduled for tomorrow would be resumed by today's START.
- **Drivers are records, not logins.** A driver is linked to a bus, never to positions.
- **Polling, not Realtime**, for the console (see "Deliberately not done").

## Gotchas and failure modes

- **Symptom:** eight "No signal from bus SIM-0x" tickets appeared the moment the engine restarted
  with the ticket job, for trips that had ended eight hours earlier.
  **Cause:** `signal_outages` rows can outlive their trip. A simulator trip that ended while the
  bus was DARK left its outage open, and the job treated every open outage as a bus someone is
  waiting for.
  **Fix:** tickets open only for trips still `running` or `dark`, and a ticket whose trip ended
  resolves itself ("The trip ended while the bus was still silent."). Verified live: all eight
  resolved within one pass.
  **Prevention:** test "never tickets an outage on a trip that has ended". Carried forward: the
  presence sweeper should close an outage when its trip ends (Stage 3/8 — dead-zone learning
  reads `duration_s`, which stays NULL for these rows).
- **Symptom:** `malformed array literal: "senior,junior"` from PGlite.
  **Cause:** PGlite cannot serialise a JS array into an **enum** array parameter
  (`$1::cohort_t[]`); it sends `String(array)`.
  **Fix:** pass `text[]` and cast in SQL: `$1::text[]::cohort_t[]`. Works on real Postgres too.
- **Symptom:** a CSV line with an unknown bus reported the same error twice.
  **Cause:** a `both` line expands into a junior and a senior row before the fleet check.
  **Fix:** errors and warnings are de-duplicated per (line, column, message).
- **Symptom (caught before it shipped):** renaming a stop would have wiped its aliases.
  **Cause:** `NewStop.partial()` keeps `aliases`' `.default([])`, so a PATCH without aliases
  parsed as `aliases: []`. Separately, the admin stop search did not return aliases, so the form
  would have submitted an empty field.
  **Fix:** a dedicated `StopPatch` schema with no defaults, and the search returns
  `aliases`/`landmark`. **Prevention:** the stop test asserts a rename leaves aliases untouched.
- **Symptom:** Zod refused `.and(...)` inside `z.discriminatedUnion`.
  **Cause:** an intersection has no discriminator. **Fix:** spread `Confirmation.partial().shape`
  into the object.
- **Symptom:** ESLint `no-irregular-whitespace` in `admin.ts`.
  **Cause:** the BOM-stripping regex held a literal U+FEFF instead of the `﻿` escape.
- **Watch for:** the out-of-commission audience is computed from favourites and today's
  subscriptions. Until Stage 6 ships the starring UI, real counts are 0 unless someone follows a
  trip. The dialog says "nobody", and the gateway still requires the count (0).
- **Watch for:** a scheduled announcement's non-custom audience is resolved at send time; the
  count confirmed hours earlier may differ. `confirmed_count` records what was agreed to.
- **Watch for:** ticket notes are visible to students who can see the ticket (SCHEMA §9). The
  ticket page says so.
- **Trivial, cost ten minutes:** the first browser run stalled on the identical re-upload because
  the file input was set while React was re-rendering after the apply. A 500 ms pause in the
  script. Not a product fault.

## Verifying locally

```bash
pnpm dev                                    # stack + web + gateway + engine + driver
npx supabase migration up --workdir infra --local   # if the stack was already running: applies 0007
pnpm test                                   # 468 tests
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  npx vitest run packages/db apps/engine/src/workers/admin.test.ts apps/gateway/src/routes/api/admin
                                            # 113 on real Supabase PG 15
# the browser run — needs a claimed td_admin and ≥1 favourite on --bus:
E2E_ADMIN_PASSWORD=… node --experimental-strip-types tests/e2e/stage7.ts --shots /tmp/shots
```

Expected browser report (2026-09-24): dashboard lists the fleet; pairing QR shown once; "This will
notify 2 students." for out of commission (typed) and again for back in service; ticket timeline
`open → resolved`; announcement "Reaches 4 students", sent; malformed CSV rejected with line 3's
`departure_time` and `cohort` errors; good CSV "1 added", published to 4; identical re-upload
"says it is the same file, notifies nobody"; `pageErrors: []`.

## Performance

| Metric | Target | Measured | Conditions |
|---|---|---|---|
| Audience count (`POST /v1/admin/audience`, all) | interactive | 1.9–7 ms | local gateway, 4 students, warm |
| Event-day preview, 60 rows (30 buses × both cohorts) | interactive | 11–24 ms | parse + fleet check + diff + insert upload row |
| Live dashboard | < 1 s | 3–4 ms | 32 buses, `fleet:live` + one Postgres query |

These are local numbers with a tiny roster; the audience query is an indexed scan of `profiles`
and `favourites`, so it should stay interactive at 1,500 students. Not yet measured at that size.

## Rolling back

```sql
DROP TABLE IF EXISTS announcement_recipients, announcements, ticket_events, tickets,
                     event_day_buses, favourites CASCADE;
ALTER TABLE buses DROP COLUMN IF EXISTS driver_id;
DROP TABLE IF EXISTS drivers;
DELETE FROM supabase_migrations.schema_migrations WHERE version = '0007';
```

This loses tickets, announcements, event-day lists and favourites. `roster_uploads` rows of kind
`event_day_buses` remain (harmless). Scheduled trips created from event-day lists remain as
ordinary trips. Revert the code by removing the files in "Files changed".

## Carried forward

> **Update 2026-09-24 (Stage 6):** the Stage 6 items below — delivering the doorbells, the lost-doorbell sweep, the starring UI, `ticket.update` frames — are done (M06). Attachments remain.

- **Stage 7 exit:** a usability session — a non-technical TD member does the three workflows
  unassisted (out of commission, an announcement to one cohort, an event-day list). Needs a
  person from the TD. 👥
- **Stage 6:** deliver the doorbells — `announcement` (audience from the row, custom via
  `announcement_recipients`), `ticket` opened (T0, bus audience) / resolved (T2, same audience),
  `event_day` (T2, `diff_summary.notify_cohorts`). Set `announcements.notification_id`, and add its
  FK in 0008. **Sweep for rows published but never delivered** (ADR-0007) — also
  `trip_subscriptions.notified_departure_at` without a notification, since leave-now has the same
  commit-then-XADD gap. Ignore doorbells older than their usefulness when a consumer group starts
  on a stream full of old events.
- **Stage 6:** the starring UI (favourites exist); `ticket.update` SSE frames for the ticket card;
  announcement attachments.
- **Stage 3 / 8:** close a `signal_outages` row when its trip ends while DARK — today it stays open
  with a NULL `duration_s` (Gotchas).
- **Later:** regular timetables (non-event days) for `scheduled` trips; stop *merge*; a driver
  shift assignment check on ingest (ARCH §10, "a device whose ping stream begins without a
  corresponding driver shift assignment").
