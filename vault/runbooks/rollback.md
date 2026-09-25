# Runbook — rolling back (a bad deploy, a bad migration, lost data)

**Symptom:** errors, alerts or wrong behaviour right after a deploy; or data that is gone.
**First question:** is it the *code* or the *data*? Code is minutes; data is the restore drill.

## 1. Code — the last deploy broke something

```bash
fly releases -a busmitra-gateway          # find the last good version
fly deploy -a busmitra-gateway --image <image of the last good release>
fly deploy -a busmitra-engine  --image <image of the last good release>
```
Web: Vercel → Deployments → the previous one → **Promote**. Driver app: Pages → the previous
deployment → **Rollback**. Engine before gateway only if the engine is the broken one; otherwise
gateway first (it is the one students feel).

Rolling code back is always safe **because migrations are expand-only** (deploy.md §2): the old
code ignores the new columns.

## 2. A migration — it must be undone

Every stage's vault entry has a **Rolling back** section with the exact SQL (e.g. M08 for 0009).
1. Roll the code back first (§1), so nothing uses what you are about to drop.
2. Run the rollback SQL in a transaction on production (`psql "$PROD_DATABASE_URL"`), then
   `DELETE FROM supabase_migrations.schema_migrations WHERE version = '<id>';`
3. Check `/admin/health` and the Live fleet page.

## 3. Data — rows are gone or wrong

1. **Stop the writers** if the damage is ongoing: `fly scale count 0 -a busmitra-engine`
   (students keep a live map from Redis; history pauses).
2. **Small and recent** (minutes to hours, one table): Supabase dashboard → Database → Backups →
   *point-in-time* (Pro) into a **new** project; copy the affected rows back with `psql \copy`.
   The `audit_log` shows exactly which admin rows changed, with before/after.
3. **Everything** (the project is gone): a new Supabase project in `ap-south-1`, then:
   ```bash
   ARCHIVE=busmitra-<stamp>.tar.enc BACKUP_PASSPHRASE=… SOURCE_URL=<the new project's URL> \
     infra/scripts/restore-drill.sh     # checks the archive restores; then restore for real:
   ```
   and restore for real with the same steps against the new project (`pg_restore` of `auth.dump`
   then `app.dump`, then `cron.sql` — the drill script is the procedure). Point `DATABASE_URL`
   and `SUPABASE_*` at the new project (fly secrets), redeploy engine + gateway.
4. `fly scale count 1 -a busmitra-engine`.

**Measured:** the drill restores the full local database in seconds (M09 "Performance");
production size (a term of positions ≈ 2 M rows) is dominated by `positions` — expect minutes.

## 4. Afterwards

Write what happened into the stage's vault entry (Gotchas) or a new runbook named after the
symptom. A rollback nobody wrote down happens twice.
