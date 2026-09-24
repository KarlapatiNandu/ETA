---
stage: M04
title: Identity and roster
status: in-progress — built, tested on real Supabase PG 15 and run live; 1 exit criterion waits on DLT (real SMS)
started: 2026-09-22
completed: —
---

# M04 — Identity and roster

## Summary

A student on the TD roster can now claim an account (roll number → OTP to the roster phone → set password) and sign in. Someone not on the roster cannot, and the API responds identically either way. Admins can import the roster CSV through a two-phase preview/apply flow and fill in missing phone numbers from a work queue. Every table has RLS with an adversarial test suite. Cohorts derive from the admission year and are promoted daily. Admin mutations are audited with actor, IP and user agent.

**Status: one exit criterion open.** The full test suite passes on PGlite and, for the DB, engine and gateway suites, on **real Supabase Postgres 15.8** (the local stack, plus a bare `supabase/postgres:15.8.1.085` container as CI will run it). The flow was also run live through `pnpm dev`: claim → OTP → Supabase Auth user → sign-in, with the JWT carrying `user_role`, RLS over PostgREST, the 404 admin surfaces, and admin promotion → CSV preview → apply into real Storage with an audited trail. The one open criterion is "claim with a **real SMS**", which waits on DLT approval and MSG91 keys. The TD's cohort definition is also still open. The boundary-derivation criterion itself is met; the *rule* is what's pending.

## Scope delivered

- [x] Supabase Auth with synthetic `<roll_no>@students.busmitra.internal` identities (`syntheticEmail` in `@busmitra/contracts`); sign-up disabled in `config.toml`, accounts created only by the claim flow
- [x] Roster import: CSV → Zod parse (header aliases, BOM, phone normalisation) → diff preview → confirm → `roster_students`. Phone-less rows import and appear in an admin work queue with inline fix
- [x] Claim flow: `POST /v1/auth/claim/{start,verify}` + `(auth)/claim` page; console SMS in dev
- [x] Rate limiting + lockout: 3 challenges/roll/hour, 5 attempts → 30 min lock, per-IP 10/min; uniform responses (ADR-0006)
- [x] Role model: `role_t`, `auth_role()`, `is_admin()`, `custom_access_token_hook` → `user_role` JWT claim
- [x] RLS written **and adversarially tested** on every table that exists (5/5), on PGlite **and real Supabase Postgres 15.8**; also exercised live over PostgREST
- [x] `derive_cohort` + `promote_cohorts` + daily `pg_cron` schedule
- [x] Audit context plumbing: `withContext()` sets `app.actor_id` / `app.client_ip` / `app.user_agent` per transaction; `audit_row()` trigger reads them
- [x] Session handling (`@supabase/ssr` middleware) + account settings page (profile, travel mode, buffer, password change, sign-out)
- [x] Password recovery over SMS: `POST /v1/auth/recover/{start,verify}` + `(auth)/recover`, reusing `claim_challenges` with `purpose = 'recover'`
- [x] `/admin` → 404 for students and anonymous callers, both in the web layout (`notFound()`) and on `/v1/admin/*`
- [x] `packages/notify` SMS adapter: console + MSG91 Flow API
- [x] Claim flow run **live** on the real stack (`pnpm dev`) with console SMS; see *Verifying locally*
- [ ] **Not demonstrated:** claim with a *real* SMS. Needs DLT approval + MSG91 keys
- [ ] **Not settled:** cohort definition with the TD. Built on the documented junior/senior enum with the rule in one SQL function
- [ ] 👥 **Not arranged:** Stage 5 soak driver (asked in the drafted TD letter)

**Deliberately not done, and why:**
- *Adversarial RLS tests for `favourites`, `push_subscriptions`, `notification_recipients`.* BUILD_PLAN names them, but those tables belong to Stages 5 and 6 and don't exist yet. The suite (`packages/db/src/rls.test.ts`) has a coverage test that fails if any new table lands without RLS and policies, so those stages cannot skip it.
- *Roster removals are reported, never applied.* Deleting a roster row would orphan a claimed profile, and a missing row is more often a spreadsheet filter than a student who left. Explicit removal goes to Stage 7.
- *Drizzle.* Migrations are hand-written SQL (ARCH §2.1 wants reviewable SQL anyway). No Drizzle schema has been generated yet, so there's no migration-drift check in CI. Carried forward.
- *BullMQ for the roster job.* It needs Redis (Stage 2). The gateway calls `@busmitra/engine/roster` in-process for now.

## Components added

| Path | What it is |
|---|---|
| `packages/db/migrations/0001_foundation.sql` | extensions, every enum, `set_updated_at` |
| `packages/db/migrations/0002_identity.sql` | identity tables, role helpers, token hook, cohort functions, audit trigger, RLS + grants, `pg_cron` jobs |
| `packages/db/src/client.ts` | `Db`/`Queryable`, `createPgDb`, `withContext` (audit context) |
| `packages/db/src/testing/` | PGlite + Supabase stub harness (`createTestDb`, `as(userId)`, `seedStudent`) |
| `packages/contracts/src/{auth,roster,roll}.ts` | claim/recover API, roster CSV parser, roll/email helpers |
| `packages/notify/src/sms.ts` | `SmsSender`, console + MSG91 |
| `apps/engine/src/workers/roster.ts` | `diffRoster`, `loadRoster`, `applyRoster` |
| `apps/gateway/` | Fastify 5: JWT auth hook, `requireAdmin` (404), OTP service, auth + admin roster routes |
| `apps/web/` | Next.js 15: `(auth)` login/claim/recover, `(student)` home + settings, `(admin)` console + roster |
| `infra/supabase/seed.sql` | synthetic dev roster + admin-promotion instructions |
| `vault/decisions/ADR-0006-uniform-claim-responses.md` | the enumeration defence |
| `vault/runbooks/student-cannot-claim.md` | runbook |

## Files changed

Stage 4 began from the same uncommitted tree as Stage 0 (base `9cabdb2`). The list below is the `git status` delta after Stage 0's snapshot.

| Status | Path | What changed and why |
|---|---|---|
| modified | `docs/SCHEMA.md` | `SECURITY DEFINER` helpers (recursion bug), `claim_challenges.purpose`/`locked_until`, decoy rows, `roster_missing_phone`, cohort functions, audit redaction + `app.actor_id`, column grants, token hook, `challenge_purpose_t` |
| modified | `packages/config/src/{env,check}.ts`, `.env.example` | removed the cohort env vars added in Stage 0. The rule lives only in SQL now |
| modified | `package.json` scripts / `turbo.json` / `tsconfig.json` / `.gitignore` / `.prettierignore` / CI | `NEXT_PUBLIC_*` build env, `dev` task, new project references, ignore mirror + tsbuildinfo |
| modified | `infra/supabase/config.toml` | global sign-up off (email provider left **on**, see Gotchas), token hook on, `minimum_password_length = 8`, private `roster-uploads` bucket |
| added | `packages/db/**` (15 files) | schema + client + test harness (PGlite, or a real server via `TEST_DATABASE_URL`) + 3 test suites |
| added | `packages/contracts/src/{auth,roll,roster,roster.test}.ts` | contracts (roll.ts moved here from db) |
| added | `packages/notify/**` (6 files) | SMS |
| added | `apps/engine/**` (5 files) | roster worker |
| added | `apps/gateway/**` (16 files) | gateway (incl. `timing.test.ts`) |
| added | `apps/web/**` (25 files) | web app |
| added | `infra/supabase/seed.sql`, ADR-0006, runbook | |

## Schema changes

| Migration | Change | Reversible? |
|---|---|---|
| `0001_foundation.sql` | `pgcrypto`, `pg_trgm`, `postgis`; all 20 enums from SCHEMA §11 + `challenge_purpose_t`; `set_updated_at()` | yes: `DROP TYPE … CASCADE; DROP FUNCTION set_updated_at();` |
| `0002_identity.sql` | `roster_uploads`, `roster_students`, `profiles`, `claim_challenges`, `audit_log`; functions `auth_role`, `is_admin`, `custom_access_token_hook`, `derive_cohort`, `operating_date`, `promote_cohorts`, `audit_row`; triggers; RLS; `pg_cron` jobs `promote-cohorts`, `purge-claim-challenges` | **destroys data** (claimed accounts, audit trail). Rollback below |

## Configuration

| Variable | Purpose | Where to obtain | Secret? |
|---|---|---|---|
| `CLAIM_DECOY_KEY` | HMAC key for decoy masked phones (ADR-0006) | `openssl rand -hex 32` | yes |
| `SMS_PROVIDER` | `console` (dev) / `msg91`. The gateway refuses `console` in production | — | no |
| `MSG91_AUTH_KEY`, `MSG91_SENDER_ID`, `MSG91_TEMPLATE_OTP` | real OTP SMS | MSG91 dashboard after DLT approval | auth key: yes |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_GATEWAY_URL` | web app | `supabase status` | no (public by design) |

Supabase Dashboard (production) must mirror `config.toml`:
- **Auth → Sign In / Providers:** turn *Allow new users to sign up* **off**, but leave the **Email provider enabled**.
- Set the minimum password length to **8**.
- **Auth → Hooks:** enable the custom access token hook → `public.custom_access_token_hook`.
- **Storage:** create the private `roster-uploads` bucket.

`TEST_DATABASE_URL` (tests only) points the DB suites at a real server. Each suite creates and drops its own database.

## Technical decisions

- **Enumeration defence by decoy challenges.** ADR-0006.
- **Role read from `profiles`, not trusted from the JWT.** `user_role` is in the token for cheap UI gating. RLS and `requireAdmin` both re-read `profiles`, so a demotion is immediate.
- **Admins cannot change roles, even their own.** Enforced by column grants, not policy. Promotion is a service-role SQL statement (`infra/supabase/seed.sql`), deliberately awkward.
- **Audit redacts the home pin** and skips a student's own preference edits. Admins read the audit log, and ARCH §10 says pins are never exposed to admins.
- **Tests run on two engines.** PGlite (Postgres 18 in WASM) gives fast, Docker-free runs anywhere. `TEST_DATABASE_URL` runs the same suites on a throwaway database on a real server, and CI's `postgres15` job does that against `supabase/postgres:15.8.1.085`. PGlite alone would have hidden the `service_role` gotcha below.
- **Workspace packages are TypeScript source run by Node's type stripping**, so the gateway has no build step (`node src/server.ts`). This is safe because `erasableSyntaxOnly` enforces it.
- **The SMS send in `startOtp` is not awaited.** An awaited provider call would make real roll numbers measurably slower than fake ones. Failures are logged (`otp sms failed`), and the runbook starts there.
- **Next.js 15** per ARCHITECTURE (16 is current, see M00).

## Gotchas and failure modes

- **Symptom:** (design review, before any code ran) every `profiles` query would fail with *infinite recursion detected in policy*.
  **Cause:** SCHEMA §9 defined `auth_role()` as plain `LANGUAGE sql STABLE`. The `profiles` policy → `is_admin()` → `auth_role()` → `SELECT FROM profiles` → policy again.
  **Fix:** `SECURITY DEFINER SET search_path = public, pg_temp`.
  **Prevention:** SCHEMA corrected; `rls.test.ts` exercises the path.
- **Symptom:** every insert into `roster_students` failed with `FOREACH expression must not be null`.
  **Cause:** in PL/pgSQL, `TG_ARGV` is **NULL**, not `'{}'`, for a trigger created without arguments.
  **Fix:** `FOREACH col IN ARRAY COALESCE(TG_ARGV, '{}')`.
  **Prevention:** the audit tests cover argument-less triggers.
- **Symptom:** (caught in review) a roster upload changing a student's admission year would compute the cohort from the *old* year.
  **Cause:** in `UPDATE … SET a = $1, b = f(a)`, `f(a)` sees the pre-update row.
  **Fix:** derive from the new-year parameter.
  **Prevention:** `roster.test.ts` asserts the cohort follows the new year on roster *and* profile.
- **Symptom:** every gateway auth test hung for 30 s.
  **Cause:** PGlite has one connection. The harness serialises transactions, and the fake Auth admin queued its insert behind the claim transaction that was calling it: a deadlock.
  **Fix:** the fake writes through `db.pglite` directly (real Supabase Auth has its own connection anyway).
  **Prevention:** comment in `apps/gateway/src/testing.ts`.
- **Symptom:** lint error `no-irregular-whitespace` in `roster.ts`.
  **Cause:** a literal U+FEFF (BOM) got written into the regex instead of the `﻿` escape.
  **Fix:** escape it.
- **Symptom:** the gateway listed only the Supabase variables as missing, then (after they were fixed) complained about the next group.
  **Cause:** separate `loadEnv` calls per group, and the first one throws.
  **Fix:** parse the intersection of all groups once.
- **Symptom:** after sign-up was disabled, *every* password login failed: `422 email_provider_disabled — Email logins are disabled`.
  **Cause:** in Supabase, `[auth.email] enable_signup = false` doesn't block sign-ups. It **disables the email provider**, login included. The global `[auth] enable_signup = false` is the switch that blocks self-sign-up.
  **Fix:** global off, email provider on. Verified live: `POST /auth/v1/signup` → `422 signup_disabled`, and password login → 200.
  **Prevention:** a comment in `config.toml`; the dashboard checklist under Configuration.
- **Symptom:** Supabase Auth accepted the 6-character password `short1` through the settings page.
  **Cause:** Auth's default `minimum_password_length` is 6. The contract's 8 is enforced only on the gateway's claim/recover endpoints, and the settings page calls Supabase Auth directly.
  **Fix:** `minimum_password_length = 8`. Verified: `422 weak_password`.
  **Prevention:** a comment pointing at `contracts/src/auth.ts`, so the two stay in step.
- **Symptom:** on real Supabase the test harness died with `"service_role" is a reserved role, only superusers can modify it`.
  **Cause:** the stub ran `ALTER ROLE service_role BYPASSRLS`. Supabase's `postgres` user isn't a superuser; PGlite's is.
  **Fix:** set BYPASSRLS only when the stub itself creates the role.
  **Prevention:** the `postgres15` CI job.
- **Symptom (latent):** `CREATE EXTENSION pg_cron` would fail in any database other than `postgres`.
  **Cause:** pg_cron can only live in `cron.database_name`.
  **Fix:** the migration guard also checks `current_database()`, so throwaway test databases on a real server skip scheduling.
- **Watch for:** `roster_students.claimed_by → auth.users` has **no** `ON DELETE`. Deleting a claimed user fails until the roster row is released (runbook §3). This is intentional: an auth user can't disappear silently from under a roster claim.

## Verifying locally

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm format:check
pnpm test            # 77 tests / 12 files — includes RLS adversarial, enumeration, lockout, recovery, roster import
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=x \
  NEXT_PUBLIC_GATEWAY_URL=http://localhost:4000 pnpm build

# the same suites on the production engine (with the stack up):
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  pnpm vitest run packages/db apps/engine apps/gateway      # 45 tests

cp .env.example .env    # fill keys from `npx supabase status --workdir infra -o env`
pnpm dev                # migrations + seed applied; gateway :4000, web :3000
# 1. http://localhost:3000/claim → roll 160125737001 → the OTP is printed in the gateway log
# 2. claim TDADMIN01 the same way, then in Studio: UPDATE profiles SET role='td_admin' WHERE roll_no='TDADMIN01';
# 3. sign in as TDADMIN01 → /admin/roster → upload a CSV → preview → apply
# 4. sign in as 160125737001 → /admin → the 404 page
```

**Observed live on 2026-09-22** (real Supabase Auth, PostgREST, Storage; console SMS):

| Check | Result |
|---|---|
| claim start / verify, seed roll `160125737001` | 200 `sent` (`+91 ••••• •0001`) → 200 `claimed` |
| claim start, roll not on roster / roll without phone | 200 `sent`, decoy masks `•4558` / `•9351`: identical shape |
| re-claim an already-claimed roll | 400, the generic code message |
| sign-in via Supabase Auth | 200; JWT `user_role: "student"` |
| student `GET /rest/v1/profiles` / `roster_students` | only own row / `[]` |
| student `PATCH` own `role` via PostgREST | **403** |
| student → gateway `/v1/admin/*` · web `/admin` | **404** · **404** (anonymous: 404; `/settings` redirects to `/login`) |
| self-sign-up `POST /auth/v1/signup` | 422 `signup_disabled` |
| 6-char password via Auth | 422 `weak_password` |
| admin (after SQL promotion): JWT claim | `user_role: "td_admin"`; web `/admin` 200 |
| admin CSV preview → apply | `preview_ready` {added 2, missing_phone 1} → 200 `applied`; two objects in Storage `roster-uploads` |
| admin malformed CSV | `rejected`, `[{row 2, full_name, "is required"}, {row 2, admission_year, "must be a year"}]` |
| audit_log | every upload/roster row: actor `TDADMIN01`, ip `127.0.0.1`, user agent set |
| claim/start timing, real vs fake roll (median of 20, interleaved) | **60.9 ms vs 61.0 ms** (`timing.test.ts`) |

## Performance

No latency targets apply to this stage, and none were benchmarked. For reference: the gateway suite takes ~6 s on PGlite, dominated by bcrypt (cost 10), and the 45 DB/engine/gateway tests take about the same on real PG 15. These are test-harness timings, not production figures.

## Rolling back

Code: remove `apps/{engine,gateway,web}`, `packages/{db,notify}` and the Stage 4 contracts files. Database (**destroys every account and the audit trail**, so export `audit_log` first):

```sql
SELECT cron.unschedule('promote-cohorts'); SELECT cron.unschedule('purge-claim-challenges');
DROP TABLE audit_log, claim_challenges, profiles, roster_students, roster_uploads CASCADE;
DROP FUNCTION audit_row(), promote_cohorts(date), operating_date(), derive_cohort(smallint,date,int,int),
              custom_access_token_hook(jsonb), is_admin(), auth_role();
DELETE FROM auth.users WHERE email LIKE '%@students.busmitra.internal';
```

Also disable the access-token hook in the Supabase dashboard first. Otherwise every sign-in fails when the function disappears.

## Carried forward

- **Exit, unmet:** claim end to end with a **real SMS**. Needs DLT approval of the OTP template (`docs/OUTREACH.md` §1) and MSG91 keys. Then set `SMS_PROVIDER=msg91` and repeat step 1 above with a real phone.
- CI's `postgres15` job must go green on GitHub. It's reproduced locally against the same image.
- **Exit, people:** the TD's cohort definition. If it's a year group rather than a shift split, migrate `cohort_t` → `year_level smallint` before Stage 7's audience queries.
- **Rate-limit store:** `@fastify/rate-limit` is in-memory, so per-IP limits reset per gateway instance. Switch to the Redis store in Stage 2 (keys via `packages/redis/keys.ts`, invariant 15).
- **Stage 5/6:** extend `rls.test.ts` with A-vs-B reads for `favourites`, `push_subscriptions`, `notification_recipients` the moment those tables exist (BUILD_PLAN Stage 4 "Test explicitly").
- **Stage 7:** explicit roster-removal action. Admin UI for roles is deliberately out of scope.
- **Drizzle + migration-drift check** in CI.
- **Playwright e2e** for claim → login → settings once the stack runs in CI.
