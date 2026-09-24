# Student cannot claim their account

**Symptom:** a student says "I entered my roll number but never got a code", "it says the code is wrong", or "it says try again in an hour / 30 minutes".

The claim page shows the same message whether or not the roll number exists (ADR-0006), so the student **cannot** tell you which case they are in. You have to check.

## 1. Find out which case it is (Supabase Studio → SQL, service role)

```sql
-- replace the roll number; roll numbers are stored upper-case
SELECT roll_no, full_name, phone_e164, claimed_at FROM roster_students WHERE roll_no = upper('160125737001');

SELECT purpose, attempts, created_at, expires_at, locked_until, consumed_at
  FROM claim_challenges WHERE roll_no = upper('160125737001') ORDER BY created_at DESC LIMIT 10;
```

| What you see | Cause | Fix |
|---|---|---|
| No roster row | Not on the TD roster (or the roll was typed differently in the CSV) | Check the CSV spelling. Add the student via a roster upload (Admin → Roster). |
| Roster row, `phone_e164` NULL | Roster arrived without their number | Admin → Roster → "Students who cannot claim yet" → enter the number. They can claim immediately. |
| Roster row, phone present but not theirs | Stale number in the TD's records | Fix the number with the TD. Updating it via the work queue works only while unclaimed. |
| `claimed_at` set | Already claimed (by them, or by someone who had their phone) | Ask them to use **Forgot password** (recovery texts the verified profile phone). If they never claimed it themselves, treat it as an incident: see §3. |
| `locked_until` in the future | 5 wrong codes | Wait it out (30 min), or clear it: `UPDATE claim_challenges SET locked_until = NULL WHERE roll_no = upper('…');` |
| 3+ rows in the last hour | Hourly limit | Wait, or delete that roll's recent rows. |
| Rows exist, eligible, no SMS arrived | SMS delivery | §2 |

## 2. SMS not arriving

- Local dev: with `SMS_PROVIDER=console` the code is **in the gateway log** (`[sms:console] to=+91… template=otp {"otp":"123456"}`). No SMS is sent.
- Production: search gateway logs for `otp sms failed`. A `"type":"error"` body from MSG91 almost always means the DLT template or sender header is not approved, or the text does not match the approved template exactly (`docs/OUTREACH.md` §1).
- The number is on the DND registry: transactional/service-implicit templates are exempt, so this should not matter. If it does, the template was registered under the wrong category.

## 3. Account claimed by the wrong person

The phone on the roster received the OTP, so whoever holds that phone claimed it. Service role:

```sql
-- capture first (this is an admin action; it is audited)
SELECT id FROM profiles WHERE roll_no = upper('…');
```

Order matters: `roster_students.claimed_by` references `auth.users` **without** cascade, so the auth user cannot be deleted while the roster row still points at it.

```sql
BEGIN;
UPDATE roster_students SET claimed_at = NULL, claimed_by = NULL, phone_e164 = '<correct +91 number>'
 WHERE roll_no = upper('…');
COMMIT;
```

Then delete the auth user in Studio → Authentication, which cascades to `profiles`. The student can now claim again with the corrected number.

## Prevention

Get phone numbers verified by the TD before the roster upload. The work queue count on the admin roster page is the leading indicator.
