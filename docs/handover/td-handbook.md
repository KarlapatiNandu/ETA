# Bus Mitra — Transport Department handbook

For the Transport Department staff who run the console at **/admin**. No technical knowledge
needed. Everything here is a button in the console; nothing needs a terminal.

---

## 1. The rule that protects students

**Nothing reaches a student's phone without three things:** you see exactly what will be sent,
you see how many students will get it, and you confirm that number. For the most urgent kind
(critical — "bus out of commission") you type the number yourself. If the number changes while
you are confirming (a student claims an account), the console stops and shows you the new
number. A CSV file never sends anything by being uploaded; only your confirmation does.

## 2. Daily: the Live fleet page (/admin)

Every bus, its signal and its trip, refreshed every 5 seconds.

| You see | It means | Do |
|---|---|---|
| **● Live** | Reporting normally | Nothing |
| **◌ Late** | Missed a few reports (a weak spot) | Nothing — it usually recovers in a minute |
| **○ No signal** | Silent for longer | If it says **known dead zone**, nothing. Otherwise watch it; after 5 minutes a ticket opens by itself |
| **not on a trip** | Driver has not pressed START | Call the driver if the bus should be running |
| **no tracker paired** | The bus has no phone or box | Pair one (§4) |
| **ETA accuracy ±N s** | How far off today's 10-minute predictions were | Green is under 90 s. Amber for a week on one route: tell campus IT |

## 3. The three core workflows

### A. A bus breaks down — "out of commission"
1. **Fleet** → the bus → **Status** → *Out of commission*, add a short note ("engine fault").
2. The console shows the students who ride that bus, and the exact message. Type the count to
   confirm. They get it at once, by push **and SMS**.
3. A ticket opens in **Tickets**. When the bus is back: open the ticket → **Resolve** with a note.
   The same students are told it is back in service.

### B. An announcement
1. **Announcements** → **New**. Choose the importance:
   - **Critical** — pushes through quiet hours; also by SMS. Only for "your bus is not coming".
   - **Important** — push; SMS for students without push.
   - **Normal / Low** — push or in-app only.
2. Choose who: everyone, juniors, seniors, one route, one bus, or a list of roll numbers.
3. Check the preview and the count → confirm. Or schedule it (up to 30 days ahead; you can
   cancel a scheduled one until it goes).

### C. Event-day bus list (exam days, special timings)
1. **Event day** → choose the date → upload the CSV (columns: `bus, route, time, cohort`).
2. The console checks every row against the fleet and the published routes. **Red rows are
   errors** — fix the file and upload again; nothing is saved. **Amber rows are warnings** (a bus
   in maintenance, no time given) — you may go ahead.
3. You see exactly what changes compared with what students see now. Confirm → only the affected
   cohort is told once. Uploading the same file again changes nothing and tells nobody.

## 4. Fleet

- **Add a bus**: number, registration, default route, regular driver.
- **Pair a driver's phone**: bus → **Pair a phone** → a QR code appears **once**. Scan it on the
  driver's phone. If it is lost, **Rotate** makes a new one (the old one keeps working for 10
  minutes so a bus on the road is not cut off).
- **Lost or stolen phone**: bus → **Unpair**. Do this the same day.
- **Wired tracker boxes** (from the hardware stage) are paired by campus IT, not in the console.

## 5. Tickets

Opened by you, or automatically when a bus is silent for 5 minutes outside a known dead zone
(those close themselves when the bus reports again). Assign, add notes, resolve. Every step is
kept.

## 6. Health (/admin/health)

Green ✓ everywhere is normal. A red ● means something needs campus IT:

| Alert | Tell campus IT |
|---|---|
| Live-map latency | "The map is slow" |
| Processing backlog | "Positions are piling up" |
| Push failures | "Push notifications are failing" |
| Bus silent too long | Call the driver first; then campus IT if the phone is fine |
| Unsaved positions | "Positions could not be saved" |

The **Learned dead zones** map shows the places where buses routinely lose signal. You may rename
a zone to something students recognise ("Uppal flyover underpass") — click its name.

## 7. Roster (new academic year)

**Roster** → upload the CSV from the office (roll number, name, admission year, phone, branch).
Rows without a phone are imported but cannot be claimed — they appear in the work queue until a
number is added. Uploads never delete anyone; removing a student is a separate, explicit action.

## 8. Audit log

Every change anyone makes in the console — who, when, and what it was before and after — is in
**Audit log**. It cannot be edited.
