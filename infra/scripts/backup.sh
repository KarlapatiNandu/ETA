#!/usr/bin/env bash
# Logical backup of the Bus Mitra database (BUILD_PLAN Stage 9) — off-site, independent of
# Supabase's own daily backups. Three parts, because they restore differently:
#   app.dump   public + supabase_migrations, schema and data (our tables, RLS, functions)
#   auth.dump  auth.users + auth.identities, data only (a new Supabase project brings the schema)
#   cron.sql   the pg_cron jobs, as idempotent cron.schedule() calls
# packed into one archive, encrypted when BACKUP_PASSPHRASE is set (it holds student data:
# production backups MUST be encrypted), and uploaded when BACKUP_S3_URI is set.
#
#   DATABASE_URL=postgresql://… BACKUP_DIR=./backups [BACKUP_PASSPHRASE=…] [BACKUP_S3_URI=s3://…] \
#     infra/scripts/backup.sh
#
# Needs only Docker (pg_dump runs from the Supabase Postgres image, matching the server).
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL}"
PG_IMAGE="${PG_IMAGE:-public.ecr.aws/supabase/postgres:15.8.1.085}"
dir="${BACKUP_DIR:-./backups}"
mkdir -p "$dir"
dir="$(cd "$dir" && pwd)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
# working files beside the backup, not in /tmp: Docker Desktop and colima only share the home
# directory with their VM, so a bind mount of /var/folders/… would write inside the VM instead
work="$(mktemp -d "$dir/.work.XXXXXX")"
trap 'rm -rf "$work"' EXIT

pg() { docker run --rm --network host -v "$work:/out" --entrypoint "$1" "$PG_IMAGE" "${@:2}"; }

start=$(date +%s)
pg pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges \
  --schema=public --schema=supabase_migrations --file=/out/app.dump
pg pg_dump "$DATABASE_URL" --format=custom --data-only \
  --table=auth.users --table=auth.identities --file=/out/auth.dump
pg psql "$DATABASE_URL" -AtqX -c \
  "SELECT format('SELECT cron.schedule(%L, %L, %L);', jobname, schedule, command) FROM cron.job ORDER BY jobname" \
  > "$work/cron.sql" || echo "-- pg_cron not available on the source" > "$work/cron.sql"
( cd "$work" && sha256sum app.dump auth.dump cron.sql > SHA256SUMS 2>/dev/null || shasum -a 256 app.dump auth.dump cron.sql > SHA256SUMS )

archive="$dir/busmitra-$stamp.tar"
tar -C "$work" -cf "$archive" app.dump auth.dump cron.sql SHA256SUMS
if [[ -n "${BACKUP_PASSPHRASE:-}" ]]; then
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE \
    -in "$archive" -out "$archive.enc"
  rm -f "$archive"
  archive="$archive.enc"
fi
if [[ -n "${BACKUP_S3_URI:-}" ]]; then
  aws s3 cp "$archive" "$BACKUP_S3_URI/$(basename "$archive")" ${BACKUP_S3_ENDPOINT:+--endpoint-url "$BACKUP_S3_ENDPOINT"}
fi
echo "backup: $archive ($(du -h "$archive" | cut -f1)) in $(( $(date +%s) - start )) s"
