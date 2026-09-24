---
stage: M00
title: Foundations
status: in-progress — all build work done and demonstrated; 2 exit criteria wait on people (GitHub push, outreach)
started: 2026-09-22
completed: —
---

# M00 — Foundations

## Summary

`pnpm dev` now brings the whole local stack up from one command, and smoke-tests it: the env check, Supabase (Postgres 15 + Auth + Storage), Redis, OSRM car and foot, the tile server, Mailpit, Photon, then the gateway and web apps. The repository is a pnpm + Turborepo monorepo with strict TypeScript, lint, format, tests and a two-job CI workflow. It has the first shared packages: `@busmitra/config`, which fails the boot and names every bad variable, and `@busmitra/contracts` (`Ping`, `PingBatch` with `cadence_s` from v1, `SseEvent`). Hyderabad routing graphs and vector tiles are built by one-time scripts and measured.

**Two exit criteria are still open, and neither is a code problem.** CI has not yet run on GitHub, because that needs a commit and push, which the owner has to authorise. The DLT registration and roster request are drafted but haven't been sent; that's a people task.

## Scope delivered

- [x] pnpm workspace + Turborepo pipeline; TS project references; `strict` + `noUncheckedIndexedAccess` (+ `erasableSyntaxOnly`)
- [x] ESLint (flat) + Prettier + `lint-staged` via `simple-git-hooks`; Vitest projects at the root
- [x] `infra/docker/docker-compose.dev.yml`: Redis 7 (AOF everysec), OSRM car + foot, Photon, tileserver-gl, Mailpit, each with a real healthcheck. Supabase via CLI (`infra/supabase/config.toml`)
- [x] `infra/osrm/prepare.sh`: Telangana extract → `osmium extract` Hyderabad bbox → extract/partition/customize ×2. **Run and measured**
- [x] `infra/tiles/prepare.sh`: Planetiler → `hyderabad.mbtiles` (`--inland` default, `--full` optional). **Run and measured**
- [x] Artefact publishing decided: **GitHub release assets** (largest is 340 MB, cap is 2 GiB)
- [x] `packages/config` + `.env.example` (every key documented; a test enforces it)
- [x] `packages/contracts`: `Ping`, `PingBatch` with `cadence_s`, `SseEvent`, `BROADCAST_EVENTS`
- [x] `.github/workflows/ci.yml`: `check` (typecheck → lint → format → test → build) + `postgres15` (DB suites on Supabase Postgres 15). Both reproduced locally; not yet run on GitHub
- [x] `vault/` subfolders; `docs/OUTREACH.md` (DLT templates + TD request drafted)
- [ ] 👥 **Not sent:** DLT registration, roster request, ridership question (drafts in `docs/OUTREACH.md`)

## Components added

| Path | What it is |
|---|---|
| `package.json`, `pnpm-workspace.yaml`, `turbo.json` | workspace root, task pipeline |
| `tsconfig.base.json`, `tsconfig.json` | shared strict compiler options; project references |
| `eslint.config.js`, `.prettierrc.json`, `.prettierignore` | lint/format |
| `vitest.config.ts` | root test runner over `packages/*` and `apps/*` projects |
| `packages/config` | `loadEnv`, `EnvError`, per-component env schemas, `PRESENCE`/`CLAIM`/`SSE` thresholds, `env:check` CLI |
| `packages/contracts` | ingest + SSE Zod contracts |
| `infra/hyderabad.env` | the one bbox, source URL and image pins shared by OSRM and tiles |
| `infra/osrm/prepare.sh` | one-time routing graph build |
| `infra/tiles/prepare.sh`, `infra/tiles/empty_sources.py` | one-time tile render; empty auxiliary sources for `--inland` |
| `infra/docker/docker-compose.dev.yml` | local services |
| `infra/supabase/config.toml` | Supabase CLI project (`busmitra`, Postgres 15) |
| `infra/scripts/{dev,dev-down,smoke}.sh` | `pnpm dev`, `pnpm dev:down`, `pnpm smoke` |
| `.github/workflows/ci.yml` | CI |
| `docs/OUTREACH.md` | DLT template text, TD request letter |

## Files changed

Stage start commit `9cabdb2`. Nothing is committed yet, so this comes from `git status --porcelain -uall` rather than a commit range.

| Status | Path | What changed and why |
|---|---|---|
| modified | `docs/BUILD_PLAN.md` | OSM source (no Geofabrik Telangana file); measured OSRM/tile numbers replace the ~8 GB estimate |
| modified | `docs/ARCHITECTURE.md` | OSM source; OSRM image is `ghcr.io/project-osrm/osrm-backend` |
| modified | `tracker.md` | per-stage build checklists; Stage 0 status |
| added | `.env.example`, `.gitignore`, `.nvmrc`, `.prettierignore`, `.prettierrc.json` | root config |
| added | `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts` | workspace |
| added | `.github/workflows/ci.yml` | CI |
| added | `packages/config/**` (8 files) | env + thresholds |
| added | `packages/contracts/**` (8 Stage 0 files) | contracts |
| added | `infra/hyderabad.env`, `infra/osrm/prepare.sh`, `infra/tiles/{prepare.sh,empty_sources.py}`, `infra/docker/docker-compose.dev.yml`, `infra/supabase/{config.toml,.gitignore}`, `infra/scripts/*.sh` | local stack |
| added | `docs/OUTREACH.md` | people-task drafts |
| added | `vault/{modules,decisions,runbooks,benchmarks}/.gitkeep`, `tests/{e2e,load,fixtures}/.gitkeep` | folder skeleton |

## Schema changes

None (the first migrations are Stage 4's).

## Configuration

Every variable is in `.env.example` with purpose, source and whether it's secret.

| Variable | Purpose | Where to obtain | Secret? |
|---|---|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `DATABASE_URL` | Supabase | `npx supabase status --workdir infra` locally; dashboard in prod | service key + JWT secret: yes |
| `REDIS_URL` | Redis | compose | no |
| `OSRM_CAR_URL`, `OSRM_FOOT_URL`, `PHOTON_URL`, `TILES_URL` | geo services | compose | no |
| `SMS_PROVIDER` (+ `MSG91_*` when `msg91`) | SMS transport | MSG91 dashboard after DLT | `MSG91_AUTH_KEY`: yes |
| `CLAIM_DECOY_KEY`, `TRACKER_SECRET_KEY`, `GATEWAY_PORT`, `WEB_ORIGIN` | gateway | `openssl rand -hex 32` | keys: yes |

Host requirements, as run on the build machine (Apple M3, 16 GB): Node 22+, pnpm 10, Docker (Colima 6 CPU / 10 GB VM was ample), `osmium-tool`, python3.

## Technical decisions

- **OSM source: Telangana extract from the OpenStreetMap France mirror.** Geofabrik publishes only six India zones (southern-zone is 558 MB) and served this machine at ~160 B/s. OSM France has a per-state file (99 MB) and served it at ~150 KB/s. The Geofabrik zone URL stays in `hyderabad.env` as the documented fallback.
- **Tiles default to `--inland`**, with empty ocean polygons, Natural Earth and lake centerlines. Hyderabad is ~300 km from the coast, and lakes and rivers come from OSM itself. Natural Earth only feeds z0–6, and lake centerlines only curve lake-name labels (they fall back to points). Those sources are ~1.4 GB, and `osmdata.openstreetmap.de` served ~5 KB/s here, which is days. The accepted consequence: no low-zoom country/landcover context, and straight lake labels. `--full` restores both for anyone on a normal link.
- **Artefacts are published as GitHub release assets** (sizes under Performance). No R2/S3.
- **TypeScript 5.9, not 7.** npm `latest` is TS 7 (the native port), and typescript-eslint 8 supports `<6.1`.
- **Next.js stays on 15** (per ARCHITECTURE), though 16 is current. A deliberate upgrade should get its own ADR.
- **Packages are consumed as TypeScript source**, with no build step. Node runs the gateway by type-stripping, which `erasableSyntaxOnly` keeps safe.
- **Supabase migrations live in `packages/db/migrations`.** `dev.sh` mirrors them into `infra/supabase/migrations` (gitignored), the only path the CLI reads.
- **OSRM image `ghcr.io/project-osrm/osrm-backend:v5.27.1`.** Docker Hub's `osrm/osrm-backend` stopped at v5.25.
- **Local Supabase pinned to Postgres 15** to match SCHEMA.md. The CLI default is 17; the image is `supabase/postgres:15.8.1.085`.
- **Dev scripts live in `infra/scripts/`**, not a new top-level `scripts/` (Read_this_first §4).
- **`next dev` uses `.next-dev`, `next build` uses `.next`.** See Gotchas.
- **Markdown is excluded from Prettier**: the docs use hand-formatted tables.

## Gotchas and failure modes

- **Symptom:** `prepare.sh` couldn't download `telangana-latest.osm.pbf` from Geofabrik, and `southern-zone` crawled at ~8 KB/s.
  **Cause:** Geofabrik has no per-state India files, and it throttled this network.
  **Fix:** OSM France's Telangana extract.
  **Prevention:** the URL lives once in `infra/hyderabad.env`, with the fallback noted.
- **Symptom:** Planetiler exits with `lake_centerline.shp.zip does not exist. Run with --download`. With `--download`, water polygons fetch at 5 KB/s (930 MB).
  **Cause:** Planetiler's OpenMapTiles profile requires all three auxiliary sources, with no skip flag.
  **Fix:** `--inland` mode writes valid empty stand-ins (`empty_sources.py`, standard library only).
  **Prevention:** it's the documented default, and `--full` is one flag away.
- **Symptom:** `prepare.sh: line 30: AUX[@]: unbound variable` on macOS.
  **Cause:** Bash 3.2 (the macOS `/bin/bash`) treats `"${arr[@]}"` of an empty array as unbound under `set -u`.
  **Fix:** `${AUX[@]+"${AUX[@]}"}`.
  **Prevention:** keep the idiom for every optional-args array in these scripts.
- **Symptom:** `docker compose up --wait` returned, then the first OSRM request got an empty reply.
  **Cause:** without a healthcheck, `--wait` only waits for *running*. `osrm-routed` needs a moment to load the graph.
  **Fix:** a TCP-connect healthcheck (`bash -c 'exec 3<>/dev/tcp/127.0.0.1/5000'`; the image has no curl). tileserver-gl checks `/health` via `node -e fetch`.
  **Prevention:** every compose service now has a healthcheck, so `--wait` means ready.
- **Symptom:** `smoke: tiles FAILED` (404) while tiles plainly served.
  **Cause:** the smoke test built `/data/<dataset id>/…` (`hyderabad`), but tileserver-gl serves `/data/v3/…`. The id and the path segment differ.
  **Fix:** use the advertised `tiles[0]` template from `data.json`, which is what MapLibre will request in Stage 3.
- **Symptom:** the Photon container exited 75: *Insufficient temp space: need 153.33 GB*.
  **Cause:** `rtuszik/photon-docker` reads `REGION`, not `COUNTRY_CODE`, and an unrecognised variable silently means the **whole planet**.
  **Fix:** `REGION: india` (a 0.56 GB index).
  **Prevention:** a comment in compose. Photon isn't on `pnpm dev`'s wait list, so its first-start download never blocks the stack.
- **Symptom:** every web page returned 500 after running `pnpm build` while `pnpm dev` was up.
  **Cause:** `next dev` and `next build` share `.next`.
  **Fix:** `distDir` chosen by phase (`.next-dev` for dev).
  **Prevention:** verified by building during a live dev session; pages stayed 200.
- **Symptom:** `pnpm env:check` crashed: `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX … parameter property`.
  **Cause:** Node's type stripping can't emit code for parameter properties or enums.
  **Fix and prevention:** explicit fields, plus `erasableSyntaxOnly: true`.
- **Symptom:** a missing `SMS_PROVIDER` reported "Invalid discriminator value".
  **Cause:** Zod reports unions as `invalid_union`.
  **Fix:** any issue on an absent key reads "is not set". Tested.
- **Symptom:** `FOO=` in `.env` passed validation.
  **Cause:** dotenv yields `""`.
  **Fix:** `loadEnv` drops empty strings. Tested.

## Verifying locally

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test     # 76 tests, 11 files
pnpm env:check                      # without .env: every missing variable named, exit 1
cp .env.example .env                # fill SUPABASE_ANON_KEY / SERVICE_ROLE_KEY / JWT_SECRET from
                                    #   npx supabase status --workdir infra -o env
infra/osrm/prepare.sh               # one-time
infra/tiles/prepare.sh              # one-time (--inland)
pnpm dev
# expected, in order:
#   env: ok
#   … Supabase started, migrations 0001–0002 applied, seed applied …
#   Container busmitra-{redis,osrm-car,osrm-foot,tiles,mailpit}-1 Healthy
#   smoke: osrm-car ok / smoke: osrm-foot ok / smoke: tiles ok / smoke: redis ok
#   gateway: Server listening at http://127.0.0.1:4000 · web: ✓ Ready
curl -s "localhost:5000/route/v1/driving/78.3197,17.3924;78.4386,17.3950?overview=false"   # "code":"Ok"
```

## Performance

Measured 2026-09-22 on an Apple M3 (16 GB), in a Colima VM with 6 vCPU / 10 GB.

| Metric | Target | Measured | Conditions |
|---|---|---|---|
| Telangana extract → Hyderabad clip | — | 99 MB → **41 MB** | bbox 78.15,17.15,78.80,17.70 |
| OSRM build, car | ≤ 8 GB RAM | **581 MB peak**, ~12 s | MLD; extract/partition/customize |
| OSRM build, foot | ≤ 8 GB RAM | **555 MB peak**, ~10 s | MLD |
| OSRM artefacts | < 2 GiB/file | **car 340 MB, foot 258 MB** | uncompressed |
| Tiles | — | **20 MB**, 1,159 tiles, **28 s** | Planetiler 0.9.1, `--inland`, z0–14 |
| Sample route CBIT → Mehdipatnam | — | car 15.4 km / 18.3 min · foot 14.7 km / 177 min | OSRM defaults, no traffic |
| Photon India index | — | 0.56 GB download; ready ~5 min after start | `REGION=india`; `q=Dilsukhnagar` → the Dilsukhnagar bus stop (Vijayawada Hwy) |
| Test suite | — | ~5 s | 76 tests, PGlite |

## Rolling back

Nothing persistent beyond local containers. `pnpm dev:down` stops the stack. `docker volume rm busmitra_redis-data busmitra_photon-data` drops its data. `rm -rf infra/osrm/data infra/tiles/data` removes the artefacts. For the code, `git checkout 9cabdb2 -- . && git clean -fd`.

## Carried forward

- **Exit, needs owner:** commit and push to GitHub; confirm both `ci` jobs are green; record the run URL here. (Both jobs have been reproduced locally, including `postgres15` against a bare `supabase/postgres:15.8.1.085` container.)
- **Exit, people:** send the DLT registration and TD letter (`docs/OUTREACH.md`), then update tracker §2 with the dates.
- Publish the OSRM and tile artefacts as a GitHub release, once there's a pushed commit to attach them to.
- **Stage 3:** the tiles are CC-BY (OpenMapTiles) over ODbL (OSM). The map **must show a visible "© OpenMapTiles © OpenStreetMap contributors" credit**.
