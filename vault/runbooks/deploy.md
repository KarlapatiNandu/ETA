# Runbook — deploying a change (and running a migration)

**When:** any change reaches production. Written for Stage 9; the first production deploy is
§4.

## 1. Before

- [ ] CI is green on the commit (`ci` workflow: typecheck, lint, format, tests on PGlite **and**
      Postgres 15, build).
- [ ] If the change has a migration: it is in `packages/db/migrations`, `docs/SCHEMA.md` changed
      with it, and it has a written rollback (the stage's vault entry, "Rolling back").
- [ ] Not between 07:00–09:30 or 16:00–18:30 IST on a college day (buses on the road).
- [ ] `/admin/health` all green.

## 2. Order — always this order

1. **Migrations** (expand-only: add columns/tables/functions; never drop or rename in the same
   deploy as the code that stops using them):
   ```bash
   npx supabase@2.117.0 db push --workdir infra --db-url "$PROD_DATABASE_URL"
   ```
   Or GitHub → Actions → **deploy** → *migrate: true*. The CLI applies only what
   `supabase_migrations.schema_migrations` does not have.
2. **Engine** — one machine, stopped before the new one starts (`strategy = "immediate"`):
   ```bash
   fly deploy -c infra/fly/engine.toml
   ```
   Unacknowledged stream entries stay pending and the new engine reads them first: nothing is
   lost, positions are at most ~20 s late on the map.
3. **Gateway** — rolling, two machines, so there is always one serving:
   ```bash
   fly deploy -c infra/fly/gateway.toml
   ```
   Each machine gets SIGTERM, closes its SSE streams and deletes their connection keys; the apps
   reconnect to the other machine within seconds, with `Last-Event-ID` replay.
4. **Web** — Vercel deploys `main` automatically; **driver app** — Cloudflare Pages likewise.
5. **Adapter** (only when changed): `fly deploy -c infra/fly/adapter.toml`. Trackers redial.

## 3. After

- [ ] `curl https://api.busmitra.in/healthz` → `{"ok":true}`; security headers present.
- [ ] `/admin/health`: all green within 2 minutes; consumer lag back to 0.
- [ ] Grafana *Bus Mitra — overview*: fix → frame p95 unchanged.
- [ ] Anything wrong → [rollback.md](rollback.md). Do not debug on production at 7:40.

## 4. The first production deploy (Stage 9)

1. Supabase Pro project in `ap-south-1`; dashboard settings to mirror `infra/supabase/config.toml`
   (sign-ups off, email provider on, min password 8, the access-token hook, private buckets
   `roster-uploads` and `route-surveys`).
2. `db push` all migrations. Give the metrics role a login:
   `ALTER ROLE busmitra_metrics LOGIN PASSWORD '<strong, stored in Grafana only>';`
3. Geo box: `infra/prod/geo` (README in its compose file); artefacts from the GitHub release.
4. Generate production secrets **once**: `openssl rand -hex 32` for `CLAIM_DECOY_KEY` and
   `TRACKER_SECRET_KEY`; `pnpm --filter @busmitra/notify vapid` for the VAPID pair. Store them in
   Fly secrets and the password manager. Never reuse development values.
5. `fly launch --no-deploy` for each app from its toml, `fly secrets set …`, then §2.
6. DNS at Cloudflare: web → Vercel; `api` → Fly (proxied, HTTP/2); `tiles` → geo box (proxied,
   cached); `geo` → geo box (**DNS only**); `driver` → Pages.
7. Grafana Cloud: import `infra/grafana/dashboards/busmitra-overview.json`, provision the alert
   rules with `BUSMITRA_PROM_UID=grafanacloud-prom`, add the Postgres datasource as
   `busmitra_metrics`, route alerts to the on-call phone.
8. Backups: set the `backup` workflow's secrets; run it once by hand; run
   `infra/scripts/restore-drill.sh` against that archive.
9. Staged rollout (below).

## 5. Staged rollout (BUILD_PLAN Stage 9: 3 → 10 → 30)

| Step | Buses | Hold for | Move on when |
|---|---|---|---|
| 1 | 3 buses on 1–2 routes, drivers briefed with the [driver sheet](../../docs/handover/driver-sheet.md) | **2 weeks** | ETA MAE < 90 s at 10 min (`pnpm sim eta-report`, the console's Health page); no alert left unexplained; ≥ 3 dead zones learned |
| 2 | 10 buses | 1 week | same, and push delivery ≥ 95 % |
| 3 | all 30 | — | — |

A bus joins the rollout by being paired (console → Fleet → Pair a phone). Students of buses not
yet paired see "no tracker" honestly rather than a fake position.
