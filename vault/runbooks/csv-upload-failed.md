# CSV upload failed

**Symptom:** the Transport Department uploads a bus list (Event day) or the student roster
(Roster), and the console says the file was not accepted — or it was accepted but the result is
not what they expected. Someone is asking why "the list didn't go through".

First, the reassurance that matters most: **a rejected file publishes nothing and notifies
nobody.** Every upload is two-phase — preview, then an explicit apply — and a file with any error
is rejected whole (ARCH §10). Nothing partial ever reaches students.

> Dev: `DB` below is `docker exec supabase_db_busmitra psql -U postgres -d postgres`.
> Production: the Supabase SQL editor.

---

## 1. The console listed errors ("This file was not accepted")

Each error is a spreadsheet **line** (the header is line 1), a **column** and a message. Fix those
cells and upload again. The common ones:

| Message | Cause | Fix |
|---|---|---|
| `column is missing from the header` | The header row does not name a bus column (`bus`, `bus no`, `bus_number`) | Rename the header cell |
| `no bus 99 in the fleet` | That bus number is not under Fleet (or is archived) | Add the bus under Fleet, or correct the number |
| `bus 9 is retired` | Retired buses cannot be listed | Use another bus, or change its status under Fleet |
| `no published route called "X"` | The route name does not match a **published** route | Copy the route name from Routes, or leave the cell blank to use the bus's usual route |
| `"X" runs both ways — add a direction column` | Two published routes share the name (inbound and outbound) | Add a `direction` column: `inbound` / `outbound` |
| `"26:00" is not a time like 7:40 AM` | Unreadable time | `7:40`, `07:40`, `7:40 AM` and `19:40` all work |
| `must be junior, senior or both` | Unknown cohort word | `junior(s)`, `senior(s)`, `both` or blank |
| `bus 14 is already listed for seniors on line 2` | The same bus twice for one cohort | Keep one line per bus per cohort |

Roster errors (roll number, name, admission year, phone) work the same way — see
`student-cannot-claim.md` for what a roster row needs to be claimable.

## 2. It was accepted, but students were not told

Only cohorts whose list **actually changed** are notified. Check the preview's summary:

- "0 added · 0 changed · 0 removed" or *"This is the same file that was published …"* — nothing
  changed, so nobody was told. That is the protection against a re-upload "to make sure it went
  through" buzzing everyone twice.
- A seniors-only file changes (and notifies) only seniors.

If changes were applied and students still were not told, it is a notification problem, not a
CSV problem: the apply rang `stream:notify` with `{type: "event_day", uploadId}`. Check the
upload's row, then go to `push-not-delivering.md` (Stage 6).

```sql
-- DB: what the console recorded for that day
SELECT id, original_name, status, applied_at, diff_summary
  FROM roster_uploads WHERE kind = 'event_day_buses' AND service_date = '2026-10-02'
 ORDER BY created_at DESC;
```

`diff_summary.notify_cohorts` is who was told; `notify_count` is how many students.

## 3. "It says the audience changed" on confirm

Someone starred a bus, a roster import landed, or a colleague applied another file while the
dialog was open. The dialog shows the new number and asks again. This is deliberate
(ADR-0007): confirm the new number.

## 4. "Someone else applied this upload" / "nothing to apply"

Each upload applies once. Upload the file again for a fresh preview — the diff is always against
the list as it is *now*.

## 5. The file was applied by mistake

There is no "undo" button, on purpose: an undo is another list, and students deserve to be told
about it. Upload the corrected list; the preview will show exactly what changes back, and only
those cohorts are notified. Every applied row is in the audit log with who applied it:

```sql
SELECT created_at, action, before, after FROM audit_log
 WHERE entity = 'event_day_buses' ORDER BY id DESC LIMIT 50;
```

## Prevention

- The parser, the checks against the fleet and the diff are covered by
  `packages/contracts/src/admin.test.ts`, `apps/engine/src/workers/admin.test.ts` and
  `apps/gateway/src/routes/api/admin/console.test.ts` (malformed file rejected whole, identical
  re-upload notifies nobody).
- `tests/e2e/stage7.ts` drives the upload → reject → preview → publish → identical re-upload path
  in a real browser.
