-- 0004 — trips, positions, stop events (SCHEMA §4). Stage 2.

-- ── trips ─────────────────────────────────────────────────────────────────

CREATE TABLE trips (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bus_id             uuid NOT NULL REFERENCES buses(id),
  route_id           uuid NOT NULL REFERENCES routes(id),
  driver_id          uuid REFERENCES profiles(id),
  service_date       date NOT NULL,
  shift              shift_t NOT NULL,
  run_seq            smallint NOT NULL DEFAULT 1,
  status             trip_status_t NOT NULL DEFAULT 'scheduled',
  scheduled_start_at timestamptz,
  started_at         timestamptz,
  ended_at           timestamptz,
  last_offset_m      double precision,
  last_seq           smallint NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bus_id, service_date, shift, run_seq)
);
CREATE INDEX ON trips (service_date, status);
CREATE INDEX trips_running ON trips (bus_id) WHERE status = 'running';
-- one *live* trip per bus: a reconnecting driver app resumes it instead of starting another
CREATE UNIQUE INDEX one_live_trip ON trips (bus_id)
  WHERE status IN ('scheduled', 'running', 'dark');
CREATE TRIGGER trips_updated_at BEFORE UPDATE ON trips
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── positions — weekly partitions (SCHEMA §4) ─────────────────────────────

CREATE TABLE positions (
  id              bigserial,
  trip_id         uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  bus_id          uuid NOT NULL,
  recorded_at     timestamptz NOT NULL,
  ingested_at     timestamptz NOT NULL DEFAULT now(),
  location        geography(Point, 4326) NOT NULL,
  speed_kmh       real,
  heading_deg     smallint,
  accuracy_m      real,
  route_offset_m  double precision,
  is_backfill     boolean NOT NULL DEFAULT false,
  PRIMARY KEY (id, recorded_at)
) PARTITION BY RANGE (recorded_at);

-- the ingest idempotency guarantee (invariant 5): a retried batch cannot duplicate a row
CREATE UNIQUE INDEX positions_trip_recorded ON positions (trip_id, recorded_at);
CREATE INDEX ON positions (trip_id, recorded_at DESC);

-- Weekly partitions, Monday 00:00 UTC. Every partition is its own table: querying one
-- directly bypasses the parent's RLS policies, so each gets RLS enabled and every client
-- grant revoked (Supabase default privileges would otherwise hand them to anon).
CREATE FUNCTION ensure_positions_partitions(weeks_back int DEFAULT 2, weeks_ahead int DEFAULT 8)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  monday timestamp := date_trunc('week', now() AT TIME ZONE 'UTC');
  lo timestamp;
  name text;
  created integer := 0;
BEGIN
  FOR w IN -weeks_back .. weeks_ahead LOOP
    lo := monday + make_interval(weeks => w);
    name := 'positions_p' || to_char(lo, 'YYYYMMDD');
    IF to_regclass('public.' || name) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF positions FOR VALUES FROM (%L) TO (%L)',
        name, (lo AT TIME ZONE 'UTC'), ((lo + interval '1 week') AT TIME ZONE 'UTC'));
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', name);
      EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated', name);
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END $$;
REVOKE ALL ON FUNCTION ensure_positions_partitions(int, int) FROM PUBLIC, anon, authenticated;

SELECT ensure_positions_partitions();

-- Retention (SCHEMA §12): drop partitions wholly older than 90 days. Created now, deliberately
-- NOT scheduled: SCHEMA says raw rows are aggregated into segment_speeds before they are
-- dropped, and that job is Stage 5. Scheduling this first would delete unaggregated history.
CREATE FUNCTION drop_expired_positions_partitions(retention interval DEFAULT interval '90 days')
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  part record;
  dropped integer := 0;
BEGIN
  FOR part IN
    SELECT c.relname,
           to_timestamp(substring(c.relname FROM 'positions_p(\d{8})'), 'YYYYMMDD') AS lo
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'public.positions'::regclass
  LOOP
    IF part.lo + interval '1 week' <= now() - retention THEN
      EXECUTE format('DROP TABLE %I', part.relname);
      dropped := dropped + 1;
    END IF;
  END LOOP;
  RETURN dropped;
END $$;
REVOKE ALL ON FUNCTION drop_expired_positions_partitions(interval) FROM PUBLIC, anon, authenticated;

-- ── trip_stop_events ──────────────────────────────────────────────────────

CREATE TABLE trip_stop_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id      uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  stop_id      uuid NOT NULL REFERENCES stops(id),
  seq          smallint NOT NULL,
  event        stop_event_t NOT NULL,
  occurred_at  timestamptz NOT NULL,
  source       event_source_t NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trip_id, seq, event)          -- the idempotency backstop (invariant 5)
);

-- ── audit ─────────────────────────────────────────────────────────────────
-- trips are written by devices and workers far more than by admins; only admin edits are
-- interesting, and audit_row records a NULL actor for service-role writes, which is honest.
CREATE TRIGGER audit_trips AFTER UPDATE OR DELETE ON trips
  FOR EACH ROW EXECUTE FUNCTION audit_row();

-- ── row-level security (SCHEMA §9) ────────────────────────────────────────

ALTER TABLE trips            ENABLE ROW LEVEL SECURITY;
ALTER TABLE positions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE trip_stop_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trips, positions, trip_stop_events FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON trips TO authenticated;
CREATE POLICY trips_read ON trips FOR SELECT TO authenticated
  USING (status IN ('running', 'completed') OR is_admin());
CREATE POLICY trips_admin ON trips FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

-- positions: admins read everything. The student policy (their subscribed trips, last 24 h)
-- needs trip_subscriptions, which is Stage 5 — until then students have no access at all,
-- which is the deny-by-default posture, not a gap.
GRANT SELECT ON positions TO authenticated;
CREATE POLICY positions_admin_read ON positions FOR SELECT TO authenticated USING (is_admin());

-- stop events are fleet data, visible alongside the trips they belong to
GRANT SELECT ON trip_stop_events TO authenticated;
CREATE POLICY trip_stop_events_read ON trip_stop_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM trips t WHERE t.id = trip_id));  -- trips' own policy applies

-- ── scheduling ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron')
     AND current_database() = COALESCE(current_setting('cron.database_name', true), 'postgres') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    -- daily at 01:00 IST; eight weeks of headroom means a missed week of cron is harmless
    PERFORM cron.schedule('ensure-positions-partitions', '30 19 * * *',
      'SELECT public.ensure_positions_partitions()');
  END IF;
END $$;
