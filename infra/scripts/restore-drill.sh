#!/usr/bin/env bash
# The restore drill (BUILD_PLAN Stage 9 exit: "backed up, restore tested"). Takes a backup of
# SOURCE_URL with backup.sh, restores it into a brand-new database shaped exactly like a fresh
# Supabase project (the Supabase Postgres image + GoTrue's own migrations), and proves it:
# every table's row count, every RLS policy, every function and trigger, the migration history,
# the cron jobs, and a PostGIS query must match the source. Prints the timings.
#
#   SOURCE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres infra/scripts/restore-drill.sh
#   ARCHIVE=backups/busmitra-….tar[.enc] infra/scripts/restore-drill.sh   # restore a given backup
#
# Run it every term against production (with the production backup), and after any change to
# backup.sh. It leaves nothing running.
set -euo pipefail
cd "$(dirname "$0")/../.."
SOURCE_URL="${SOURCE_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
PG_IMAGE="${PG_IMAGE:-public.ecr.aws/supabase/postgres:15.8.1.085}"
GOTRUE_IMAGE="${GOTRUE_IMAGE:-public.ecr.aws/supabase/gotrue:v2.196.0}"
PORT="${RESTORE_PORT:-55432}"
NET=busmitra-restore-drill
PGC=busmitra-restore-drill-db
TARGET="postgresql://postgres:postgres@127.0.0.1:$PORT/postgres"
# inside the repository (git-ignored), not /tmp: Docker's VM only sees the home directory
work="$(mktemp -d "$PWD/.restore-drill.XXXXXX")"
cleanup() {
  docker rm -f "$PGC" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
t() { date +%s; }
psql_() { docker run -i --rm --network host --entrypoint psql "$PG_IMAGE" "$1" -v ON_ERROR_STOP=1 -AtqX "${@:2}"; }

T0=$(t)
# ── 1. the backup ───────────────────────────────────────────────────────────
if [[ -z "${ARCHIVE:-}" ]]; then
  out=$(DATABASE_URL="$SOURCE_URL" BACKUP_DIR="$work/backups" bash infra/scripts/backup.sh)
  echo "$out"
  ARCHIVE="$(ls "$work"/backups/busmitra-*)"
fi
T1=$(t)
if [[ "$ARCHIVE" == *.enc ]]; then
  : "${BACKUP_PASSPHRASE:?the archive is encrypted: set BACKUP_PASSPHRASE}"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$ARCHIVE" -out "$work/b.tar"
else
  cp "$ARCHIVE" "$work/b.tar"
fi
mkdir -p "$work/b" && tar -C "$work/b" -xf "$work/b.tar"
( cd "$work/b" && (sha256sum -c SHA256SUMS 2>/dev/null || shasum -a 256 -c SHA256SUMS) >/dev/null )
echo "restore-drill: archive verified ($(du -h "$ARCHIVE" | cut -f1))"

# ── 2. a fresh Supabase-shaped database ─────────────────────────────────────
docker network create "$NET" >/dev/null
docker run -d --name "$PGC" --network "$NET" -p "$PORT:5432" -e POSTGRES_PASSWORD=postgres \
  "$PG_IMAGE" postgres -c config_file=/etc/postgresql/postgresql.conf >/dev/null
for _ in $(seq 1 90); do
  psql_ "$TARGET" -c "select 1" >/dev/null 2>&1 && break
  sleep 1
done
# the image gives its service roles no usable password; a new Supabase project has one
docker exec "$PGC" psql -U supabase_admin -h 127.0.0.1 -d postgres -qAtc \
  "ALTER ROLE supabase_auth_admin WITH PASSWORD 'postgres'" >/dev/null
# GoTrue migrates the auth schema to its current shape, as it does for every new project
docker run --rm --network "$NET" \
  -e GOTRUE_DB_DRIVER=postgres \
  -e "DATABASE_URL=postgres://supabase_auth_admin:postgres@$PGC:5432/postgres" \
  -e GOTRUE_JWT_SECRET=restore-drill-only-secret-0123456789abcdef \
  -e API_EXTERNAL_URL=http://localhost -e GOTRUE_SITE_URL=http://localhost \
  "$GOTRUE_IMAGE" gotrue migrate >/dev/null
T2=$(t)

# ── 3. restore: extensions, auth data, our schema + data, cron ─────────────
psql_ "$TARGET" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
  CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
  CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;
  CREATE EXTENSION IF NOT EXISTS pg_cron;"
restore() {
  docker run --rm --network host -v "$work/b:/in" --entrypoint pg_restore "$PG_IMAGE" \
    --dbname="$TARGET" --no-owner --no-privileges --exit-on-error "$@"
}
restore --data-only /in/auth.dump
# CREATE EXTENSION and the public schema already exist in a fresh project; everything else must
# restore cleanly
docker run --rm --network host -v "$work/b:/in" --entrypoint pg_restore "$PG_IMAGE" \
  --list /in/app.dump | grep -vE ' EXTENSION | SCHEMA - public | COMMENT - SCHEMA public ' > "$work/b/app.list"
restore --use-list=/in/app.list /in/app.dump
psql_ "$TARGET" -f - < "$work/b/cron.sql" >/dev/null
# the grants pg_dump --no-privileges left out: the API roles' access comes from the migrations'
# GRANT statements, which are re-applied by replaying just those lines
docker run --rm --network host -v "$PWD/packages/db/migrations:/m:ro" --entrypoint sh "$PG_IMAGE" -c \
  "cat /m/*.sql | grep -E '^\s*(GRANT|REVOKE) ' | psql '$TARGET' -qX -v ON_ERROR_STOP=0 >/dev/null 2>&1" || true
T3=$(t)

# ── 4. prove it ────────────────────────────────────────────────────────────
counts() {
  psql_ "$1" -c "SELECT string_agg(format('%s=%s', relname, n), ' ' ORDER BY relname) FROM (
    SELECT c.relname, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text::bigint AS n
      FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
     WHERE s.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition
       AND c.relname NOT IN ('spatial_ref_sys')) t"
}
shape() {
  psql_ "$1" -c "SELECT format('policies=%s rls_tables=%s functions=%s triggers=%s views=%s migrations=%s auth_users=%s cron_jobs=%s',
    (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'),
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relrowsecurity),
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')),
    (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal),
    (SELECT count(*) FROM pg_views WHERE schemaname = 'public' AND viewname NOT IN ('geography_columns','geometry_columns')),
    (SELECT string_agg(version, ',' ORDER BY version) FROM supabase_migrations.schema_migrations),
    (SELECT count(*) FROM auth.users),
    (SELECT count(*) FROM cron.job))"
}
geo() {
  psql_ "$1" -c "SELECT count(*) || ' routes, ' || round(coalesce(sum(ST_Length(geometry)), 0)) || ' m' FROM routes"
}
src_c=$(counts "$SOURCE_URL"); dst_c=$(counts "$TARGET")
src_s=$(shape "$SOURCE_URL"); dst_s=$(shape "$TARGET")
src_g=$(geo "$SOURCE_URL"); dst_g=$(geo "$TARGET")
T4=$(t)

ok=true
[[ "$src_c" == "$dst_c" ]] || { ok=false; echo "restore-drill: ROW COUNTS DIFFER"; diff <(tr ' ' '\n' <<<"$src_c") <(tr ' ' '\n' <<<"$dst_c") || true; }
[[ "$src_s" == "$dst_s" ]] || { ok=false; echo "restore-drill: SHAPE DIFFERS"; echo " source: $src_s"; echo " target: $dst_s"; }
[[ "$src_g" == "$dst_g" ]] || { ok=false; echo "restore-drill: POSTGIS DIFFERS: $src_g vs $dst_g"; }
tables=$(tr ' ' '\n' <<<"$dst_c" | wc -l | tr -d ' ')
rows=$(tr ' ' '\n' <<<"$dst_c" | cut -d= -f2 | paste -sd+ - | bc)
echo "restore-drill: $tables tables, $rows rows · $dst_s · $dst_g"
echo "restore-drill: backup $((T1 - T0)) s · fresh database $((T2 - T1)) s · restore $((T3 - T2)) s · verify $((T4 - T3)) s · total $((T4 - T0)) s"
$ok && echo "restore-drill: OK — the restored database matches the source" || { echo "restore-drill: FAILED"; exit 1; }
