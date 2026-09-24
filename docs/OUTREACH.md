# Outreach drafts — Stage 0 people tasks

> Drafts for the external requests BUILD_PLAN Stage 0 says to start on day one. **Sending them is a human task.** Record the send date in `tracker.md` §2 the moment each one goes out. No personal data belongs in this file.

---

## 1. MSG91 DLT registration

DLT (TRAI's Distributed Ledger for commercial SMS) approves the **entity**, the **sender header** and **each content template** separately. Anything sent that does not match an approved template word-for-word is dropped by the operator. Register all of these together so Stage 6 does not wait a second time.

**Entity:** the college (CBIT) as principal entity, via an operator DLT portal (Jio / Airtel / Vi / BSNL — any one), then link the entity ID in MSG91.

**Sender header (6 chars, category *Service Implicit*):** `BUSMTR` — first choice. Alternates: `CBITBS`, `BUSMIT`.

**Content templates** — `{#var#}` is the DLT variable placeholder (max 30 chars each).

| Use | Tier | Category | Template text |
|---|---|---|---|
| Account claim / password reset OTP | — (Stage 4) | Service Implicit | `{#var#} is your Bus Mitra verification code. It expires in 10 minutes. Do not share it with anyone. -CBIT Transport` |
| Leave now | T1 | Service Implicit | `Bus Mitra: Leave now. Bus {#var#} reaches {#var#} in about {#var#} min. -CBIT Transport` |
| Main bus started | T1 | Service Implicit | `Bus Mitra: Your Bus {#var#} has started its {#var#} trip. -CBIT Transport` |
| Bus out of commission | T0 | Service Implicit | `Bus Mitra ALERT: Bus {#var#} is out of service {#var#}. {#var#} -CBIT Transport` |
| Bus back in service | T0 follow-up | Service Implicit | `Bus Mitra: Bus {#var#} is back in service. {#var#} -CBIT Transport` |

The copy is not final, but a template can be *added* later far more cheaply than the entity and header can be registered — the clock that matters is the first approval.

---

## 2. To the Transport Department — roster, ridership, cohort

> **Subject:** Bus Mitra — three things we need from the Transport Department
>
> Dear Sir/Madam,
>
> We have started building Bus Mitra, the live bus-tracking app for the college fleet. Three pieces of information from your office decide how we build it, and one of them blocks us within the next two weeks:
>
> 1. **Student bus roster (needed first).** A spreadsheet of students who use the college buses with these columns: *roll number, full name, admission year, mobile number, branch.* Students sign in with their roll number and confirm their identity with a one-time code sent to the mobile number on this list, so the list decides who can use the app. Rows with a missing mobile number are fine — we will show them to your office to fill in later.
> 2. **Daily ridership.** Roughly how many students ride the buses on a normal day, morning and evening. This sets how large a system we need; an estimate is enough.
> 3. **What "junior" and "senior" mean for the buses.** Is it two separate departure waves (for example first-years on one set of buses and times, everyone else on another)? Or do you need to message a specific year, e.g. only the second-years? If it is a split, which years fall on each side?
>
> We will also, in about three weeks, need **one driver and one route for about a week** to measure how accurate the arrival times are before any alerts go live. We would be grateful if you could suggest a driver who might be willing.
>
> The roster will be handled only inside the app's database, never shared, and used only for sign-in and bus alerts.
>
> Thank you,
> Bus Mitra team, Department of IT

---

## 3. ODbL (ten minutes of reading, before Stage 9)

Read <https://opendatacommons.org/licenses/odbl/1-0/> §4.4 (Derivative Databases) and the OSMF *Produced Work* guideline, and record the decision in `tracker.md` §2.
