# ADR-0006 — Uniform claim responses: decoy challenges, not careful error messages

**Status:** accepted · **Stage:** 4 · **Date:** 2026-09-22

## Context

The roster is the student directory. `POST /v1/auth/claim/start` takes a roll number and must not reveal whether it is on the roster (BUILD_PLAN Stage 4 exit criterion). Two parts of the design pull against that:

1. SCHEMA §1 shows the student a masked phone ("+91 ••••• •3210") so they can tell whether the code went to their number. A roll number with no phone to mask stands out immediately.
2. The per-roll limits (3 challenges/hour, lockout after 5 wrong codes) are counted from `claim_challenges`. If only real claims create rows, the 4th request is a 429 for a real roll and a 200 for a fake one, which leaks the roster one request at a time.

## Options considered

- **A. Generic message, no masked phone.** Say "if you are on the roster, a code was sent". This leaks nothing, but it drops a real usability feature: students whose TD-held number is wrong have no way to notice.
- **B. Masked phone for real rolls, a plain message for the rest.** Leaks through the response shape.
- **C. Keep limit counters somewhere else (Redis, keyed by roll number) for every request.** Uniform, but it needs Redis before Stage 2 brings it in, and it still leaves the masked-phone shape problem.
- **D. Decoy challenges (chosen).** Every start request, whether the roll is real, fake, claimed or missing a phone, bcrypts a fresh random code and inserts a real `claim_challenges` row. Only the SMS send is conditional, and it is not awaited. Unknown rolls get a **stable decoy mask**: HMAC(`CLAIM_DECOY_KEY`, roll_no) → 4 digits, so repeated requests for the same fake roll show the same digits, just as a real roll would.

## Consequences accepted

- `claim_challenges` rows exist for roll numbers that were never on the roster. `roll_no` therefore has no FK, and the hourly `pg_cron` purge (24 h retention) bounds the table.
- A correct guess of a decoy code (1 in 10⁶ per attempt, capped at 5 attempts per 30 min) reaches the eligibility check and gets the same generic failure. The window is negligible and the answer is still uniform.
- The masked number is shown even to people who are not on the roster. The page wording ("If <roll> is eligible, a code was sent to …") avoids promising a delivery.
- Timing: both paths run the same queries plus one bcrypt, and the SMS network call is fire-and-forget. `apps/gateway/src/routes/api/auth/timing.test.ts` interleaves 20 real and 20 fake rolls and asserts the medians differ by less than 25% of one bcrypt. Measured 2026-09-22: **real 60.9 ms, fake 61.0 ms**.
- `CLAIM_DECOY_KEY` is a secret. If it leaks, an attacker could compute decoy masks and tell them apart from real ones. Rotating it changes every decoy mask, which is harmless.
