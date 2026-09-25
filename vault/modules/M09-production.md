---
stage: M09
title: Production and hardware
status: in-progress
started: 2026-09-24
completed: —
---

# M09 — Production and hardware

## Summary

Everything production needs now exists as code and has been proven locally: container images
for the gateway, engine and GT06 adapter (built and run in production mode), Fly.io, Vercel,
Cloudflare Pages and geo-box configurations, a manual deploy workflow in the runbook's order, a
nightly encrypted off-site backup, and a **restore drill that rebuilds the database into a
fresh Supabase-shaped instance and proves it matches** (31 tables, 90,316 rows, every policy,
function, trigger, view, migration, auth user and cron job, in 6 s). The web app sends a
per-request nonce CSP that a real browser confirms blocks nothing the app needs; the gateway and
driver app send their own hardened headers; push endpoints can no longer be aimed at internal
addresses. A wired GT06 tracker can replace a driver's phone through `apps/adapter` without any
change downstream. The driver app speaks Telugu and Hindi; the handover pack is written.

What this stage **cannot** finish from a laptop — and is therefore open — is everything that
needs an account, money, a device or elapsed time: provisioning production, the two-week pilot
with MAE < 90 s, validating the adapter against a physical tracker, and the staged 3 → 10 → 30
rollout. Each has a runbook.

## Scope delivered

- [x] Production shape per ARCH §9, as configuration: `infra/fly/{gateway,engine,adapter}.toml`
      (Mumbai, SIGTERM, health checks, one engine, connection-based concurrency),
      `infra/prod/geo` (OSRM ×2, Photon, tiles, Caddy TLS; OSRM/Photon behind a path token),
      `apps/web/vercel.json` (`bom1`), `apps/driver/public/_headers` (Cloudflare Pages)
- [x] One image recipe for the Node services (`infra/docker/Dockerfile.node`), non-root,
      SIGTERM-clean; built and run in production mode against the local stack
- [x] Migration + rollback runbooks (`deploy.md`, `rollback.md`); daily encrypted backups
      (`infra/scripts/backup.sh`, `.github/workflows/backup.yml`) with a **tested restore**
      (`infra/scripts/restore-drill.sh`)
- [x] TLS/HTTP/2 at the edge (Fly, Cloudflare), CSP and security headers on web, gateway, driver
- [x] Hardware tracker adapter emitting the identical `PingBatch` (GT06, ADR-0008), with a
      byte-exact software tracker for tests; `tracker provision --kind hardware`
- [x] Staged rollout 3 → 10 → 30 written as a procedure with entry criteria (`deploy.md` §5)
- [x] Driver sheet (EN/TE/HI), TD handbook, student guide, campus-IT handover (`docs/handover/`)
- [x] Carried in and done: the driver app translated (Telugu, Hindi — draft, for native review);
      the student app's offline shell; production VAPID keys generated once (deploy.md); HTTP/2
      (edge config); the ODbL question written up as a proposed decision (ADR-0010)
- [x] Found and fixed on the way: the gateway never closed itself on SIGTERM (a deploy would
      have left every SSE connection key to expire instead of being deleted); push endpoints were
      an SSRF vector; Sentry v11's defaults would have shipped stack-frame variables
- [ ] 👥 Provision production (Supabase Pro, Fly, Redis, geo VPS, Cloudflare, domain) — needs the
      owner's accounts and budget
- [ ] 👥 Two-week pilot on 3 buses; ETA MAE < 90 s measured
- [ ] 👥 Adapter validated against one physical GT06 tracker

**Deliberately not done, and why:**
- The student-facing *notification copy* is still English only; translating it needs a
  per-student language setting (a migration and UI) — carried forward.
- The driver bundle stays React (80 kB gzipped with three languages); the `preact/compat` lever
  from M02 is not needed yet.
- Stop merge and the driver shift-assignment check on ingest (carried from Stage 7) — still open.

## Components added

| Path | What it is |
|---|---|
| `apps/adapter` | GT06 codec (`gt06.ts`), TCP server (`server.ts`), per-device signed uplink with ignition-driven trips (`uplink.ts`), fake device, entry point |
| `infra/docker/Dockerfile.node`, `.dockerignore` | the gateway/engine/adapter image |
| `infra/fly/*.toml`, `infra/prod/geo/*`, `apps/web/vercel.json`, `apps/driver/public/_headers` | production configuration |
| `infra/scripts/backup.sh`, `infra/scripts/restore-drill.sh`, `.github/workflows/{backup,deploy}.yml` | backups, the restore drill, deploys |
| `apps/web/lib/csp.ts`, `apps/web/middleware.ts`, `apps/web/next.config.ts`, `apps/gateway/src/plugins/security.ts` | CSP and security headers |
| `packages/contracts/src/notify.ts` (`isPushServiceEndpoint`) | push-endpoint allowlist |
| `apps/web/lib/push-key.ts`, `apps/web/lib/push.ts` | re-subscribe when the VAPID key changed |
| `apps/web/public/{sw.js,offline.html}` | offline shell |
| `apps/driver/src/i18n.ts` | EN / తెలుగు / हिन्दी |
| `docs/handover/*` | the handover pack |
| `tests/e2e/stage9-csp.ts` | the CSP check in a real browser |

## Files changed

| Status | Path | What changed and why |
|---|---|---|
| added | `apps/adapter/**` | the adapter and its tests |
| modified | `apps/gateway/src/cli/tracker.ts` | `--kind hardware` |
| modified | `packages/contracts/src/ingest.ts`, `apps/gateway/src/routes/tracker/index.ts` | `TrackerMe.default_route_id` (additive) for ignition-driven trips |
| modified | `packages/config/src/env.ts`, `.env.example` | `adapterEnv` |
| added | `apps/gateway/src/plugins/security{,.test}.ts`; modified `app.ts`, `server.ts` | headers, HSTS in production |
| modified | `packages/contracts/src/notify.ts`, `apps/gateway/src/routes/api/notifications.test.ts` | SSRF allowlist + tests |
| added | `apps/web/lib/csp{,.test}.ts`, `lib/push-key{,.test}.ts`, `public/offline.html`, `vercel.json`; modified `middleware.ts`, `app/layout.tsx`, `next.config.ts`, `lib/push.ts`, `public/sw.js`, `instrumentation-client.ts`, `package.json` (`zod`) | CSP, VAPID heal, offline shell |
| added | `apps/driver/src/i18n{,.test}.ts`, `public/_headers`; modified `src/App.tsx`, `src/styles.css` | translation, headers |
| added | `infra/docker/Dockerfile.node`, `.dockerignore`, `infra/fly/*.toml`, `infra/prod/geo/*`, `infra/scripts/{backup,restore-drill}.sh`, `.github/workflows/{backup,deploy}.yml` | production |
| added | `docs/handover/{driver-sheet,td-handbook,student-guide,campus-it}.md` | handover |
| added | `tests/e2e/stage9-csp.ts` | browser check |
| modified | `docs/ARCHITECTURE.md` (§3, §10), `docs/BUILD_PLAN.md` (folder structure), `.gitignore` | docs |
| added | `vault/decisions/ADR-0008-gt06-hardware-adapter.md`, `ADR-0010-route-data-licence.md`, `vault/runbooks/{deploy,rollback}.md` | ritual |

## Schema changes

None of its own. (Stage 8's `0009` is the last migration.)

## Configuration

| Variable | Purpose | Where to obtain | Secret? |
|---|---|---|---|
| `GATEWAY_URL` | the gateway the adapter signs to | the deployment | no |
| `ADAPTER_PORT` | TCP port for GT06 trackers (5023) | — | no |
| `ADAPTER_DEVICES_FILE` / `ADAPTER_DEVICES_JSON` (Fly) | IMEI → tracker secret and intervals | `pnpm tracker provision --kind hardware` | **yes** |
| `BACKUP_PASSPHRASE` | AES-256 key for backup archives | password manager, never the repo | **yes** |
| `BACKUP_S3_URI`, `BACKUP_S3_ENDPOINT`, `AWS_*` | off-site bucket (Cloudflare R2) | Cloudflare | **yes** |
| `PROD_DATABASE_URL`, `FLY_API_TOKEN` | GitHub Actions deploy/backup | Supabase, Fly | **yes** |
| `GEO_TOKEN`, `DOMAIN`, `ACME_EMAIL` | the geo box | `openssl rand -hex 24` | **yes** (token) |

## Technical decisions

- **GT06 first, behind a decoder seam; the adapter signs as each tracker** — ADR-0008.
- **Route data under ODbL** — proposed, the owner decides (ADR-0010).
- **Nonce + `strict-dynamic` CSP, therefore every page rendered per request.** Rejected:
  `'unsafe-inline'` scripts (no XSS protection left) and hashes (Next's inline scripts change per
  build). Accepted: the three small static pages (login, claim, recover) are now dynamic.
- **`upgrade-insecure-requests` only when the gateway is https** — on an http LAN deployment it
  would rewrite every API call to an https URL nobody serves.
- **Images run the TypeScript sources** (Node 22 type stripping) with a server-only workspace;
  no build step, no bundler, and the stack traces point at real lines.
- **Backups are logical and ours**, on top of Supabase's: auth data only (a new project brings
  GoTrue's schema), our schema + data, the cron jobs — restored in that order, verified by count.
- **The engine deploys with `strategy = "immediate"`**: two geo consumers must never overlap.
- **Parked fixes are dropped by the adapter**: positions outside a trip belong to no trip, and
  pinning yesterday's depot fixes onto the morning trip would be both wrong and tracking.

## Gotchas and failure modes

- **Symptom:** the gateway image was 955 MB. **Cause:** `pnpm fetch` fills
  `node_modules/.pnpm` with every package in the lockfile — Next.js, SWC, MapLibre included — and
  `--filter` then only links. **Fix:** a server-only workspace inside the image and a plain
  install; **325 MB** (engine 296 MB). **Prevention:** a comment at the step.
- **Symptom:** `docker build` failed with "the --mount option requires BuildKit". **Cause:** the
  local Docker uses the legacy builder. **Fix:** no cache mounts; the image builds anywhere.
- **Symptom:** a production-mode gateway ignored SIGTERM's intent — streams were cut, not closed,
  and their connection keys lived out their 45 s TTL. **Cause:** nothing called `app.close()`.
  **Fix:** a SIGTERM/SIGINT handler with a 10 s force-exit (verified: "gateway: shutting down"
  and a clean stop in the container).
- **Symptom:** every page logged a CSP violation for `eval` — Zod 4's JIT probe. **Fix:**
  `z.config({ jitless: true })` in the browser (M08).
- **Symptom:** the restore drill failed four ways before it passed: files written inside the
  Docker VM (`mktemp` under `/var/folders`, which colima does not share); GoTrue refused its
  password (the image sets none; `supabase_admin` sets it); `--disable-triggers` needs ownership
  of `auth.users`; `CREATE SCHEMA public` already exists; and cron jobs silently missing because
  `docker run` without `-i` gives psql no stdin. Each is fixed and commented in the script — a
  restore procedure nobody has run does not work.
- **Symptom:** a GT06 frame hidden behind line noise that looked like a start marker was lost.
  **Cause:** on a CRC failure the reader discarded the whole misread "frame". **Fix:** resync one
  byte past the false start; tested with the manual's packets.
- **Symptom:** the admin API could not find users the load seeder had inserted straight into
  `auth.users`. **Cause:** GoTrue keeps its own view (identities, instance). **Fix:** test
  accounts that must sign in are created through the admin API.
- **Watch for:** zsh treats `$a:local` as the `:l` modifier — images got tagged
  `busmitra-engineocal`. Use `${a}`.

## Verifying locally

```bash
pnpm vitest run apps/adapter                      # 17: codec (manual's vectors), uplink, end to end
bash infra/scripts/restore-drill.sh               # "restore-drill: OK — the restored database matches"
docker build -f infra/docker/Dockerfile.node --build-arg APP=gateway --build-arg ENTRY=src/server.ts -t busmitra-gateway .
(cd apps/web && npx next build && npx next start -p 3000) &    # plus the gateway (pnpm dev)
E2E_ROLL=<an admin roll> E2E_PASSWORD=… \
  node --experimental-strip-types tests/e2e/stage9-csp.ts         # {"ok": true, "violations": []}
curl -sI localhost:3000/login | grep -i content-security-policy
```

## Performance

| Metric | Target | Measured | Conditions |
|---|---|---|---|
| Backup (logical, 3 parts) | — | 3.9 MB, **1 s** | local database: 31 tables, 90,316 rows |
| Restore into a fresh Supabase-shaped DB, verified | tested | **6 s** end to end, everything matches | same; encrypted archive too |
| Images | small enough to deploy fast | gateway 325 MB, adapter 325 MB, engine 296 MB | `node:22-alpine` |
| CSP on a production build | nothing the app needs blocked | **0 violations, 0 page errors**, both maps drawn, login works | headless Chrome, 7 pages |
| GT06 → stream:pings | identical `PingBatch` | fields equal a phone's but `device_uid`; backfill flagged | fake device, real gateway |

## Rolling back

Nothing in production to roll back yet. Locally: revert the stage's files; the adapter and the
deploy/backup workflows are inert without their secrets.

## Carried forward

- 👥 **Provision production** and deploy (deploy.md §4), then run the restore drill against the
  first production backup.
- 👥 **Pilot**: 3 buses for two weeks; MAE < 90 s at 10 min (`pnpm sim eta-report`); ≥ 3 dead
  zones learned (Stage 8 soak); then 10, then 30.
- 👥 **A physical GT06** (or whichever device the TD buys — then a decoder for its protocol):
  run `adapter.test.ts`'s steps with the box, over a SIM, including a re-upload after a dead zone.
- 👥 Native-speaker review of the Telugu and Hindi strings (driver app, driver sheet).
- The owner's decision on ADR-0010 (route data under ODbL) before the public launch.
- Student notification copy in Telugu/Hindi (needs a language preference); stop merge; the
  driver shift-assignment check on ingest.
