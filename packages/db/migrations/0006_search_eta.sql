-- 0006 — Stage 5, stops, search and personal ETA (SCHEMA §4, §5).
--
--   segment_speeds + segment_speed_runs   the learned traffic model and its nightly ledger
--   trip_subscriptions, walk_eta_cache     "the bus I am taking today", and how far I am from it
--   eta_predictions                        predicted vs actual, per stop: the MAE gate's evidence
--   profiles.home_location                 coarsened to ~100 m by the database, not the client
--   positions                              the student policy promised in 0004

-- ── the learned traffic model (ARCH §5.5) ────────────────────────────────

CREATE TABLE segment_speeds (
  route_lineage_id uuid NOT NULL,      -- lineage, not version — survives a re-survey (invariant 7)
  segment_idx   integer NOT NULL CHECK (segment_idx >= 0),   -- 200 m bucket along the route
  -- 0..6 = the day (0 Sunday); 7 = any weekday, 8 = weekend (the ARCH §5.5 rung-2 class);
  -- NULL = aggregated across days
  weekday       smallint CHECK (weekday BETWEEN 0 AND 8),
  tod_bucket    smallint CHECK (tod_bucket BETWEEN 0 AND 95),  -- 15-minute bucket; NULL = any time
  median_kmh    real NOT NULL,
  p10_kmh       real NOT NULL,
  p90_kmh       real NOT NULL,
  sample_count  integer NOT NULL CHECK (sample_count > 0),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- a PRIMARY KEY cannot contain expressions, and NULL never equals NULL in a unique constraint
CREATE UNIQUE INDEX segment_speeds_key ON segment_speeds
  (route_lineage_id, segment_idx, COALESCE(weekday, -1), COALESCE(tod_bucket, -1));

-- one row per service day aggregated: running the job twice must not count a day twice
CREATE TABLE segment_speed_runs (
  service_date date PRIMARY KEY,
  samples      integer NOT NULL DEFAULT 0,
  ran_at       timestamptz NOT NULL DEFAULT now()
);

/*
 * Aggregate one service day's positions into segment_speeds, incrementally (SCHEMA §4: never a
 * full recompute over 90 days). Samples are consecutive fixes of one trip, at most 60 s apart,
 * that made forward progress; the speed is attributed to the 200 m segment of their midpoint.
 * Standing still is excluded: dwell is modelled separately (route_stops.expected_dwell_s), and
 * counting it here would charge every stop twice.
 *
 * Four rungs are written — (day, tod), (weekday class, tod), (tod), (any) — the ARCH §5.5
 * fallback ladder. Merging into existing rows weights each statistic by sample count: exact for
 * the first night, an approximation of the true median after that (the price of not keeping
 * raw samples past the 90-day retention).
 *
 * Idempotent per day through segment_speed_runs.
 */
CREATE FUNCTION aggregate_segment_speeds(day date) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n integer;
BEGIN
  INSERT INTO segment_speed_runs (service_date) VALUES (day) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  CREATE TEMP TABLE _speed_samples ON COMMIT DROP AS
  WITH p AS (
    SELECT r.lineage_id AS lin, p.recorded_at, p.route_offset_m AS s,
           lag(p.route_offset_m) OVER w AS ps, lag(p.recorded_at) OVER w AS pt
      FROM positions p
      JOIN trips t ON t.id = p.trip_id
      JOIN routes r ON r.id = t.route_id
     WHERE t.service_date = day
       -- the operating day in IST, plus the small hours an evening trip may run into
       AND p.recorded_at >= (day::timestamp AT TIME ZONE 'Asia/Kolkata')
       AND p.recorded_at <  ((day + 1)::timestamp AT TIME ZONE 'Asia/Kolkata') + interval '6 hours'
       AND p.route_offset_m IS NOT NULL
    WINDOW w AS (PARTITION BY p.trip_id ORDER BY p.recorded_at)
  )
  SELECT lin,
         floor(((s + ps) / 2) / 200)::int AS seg,
         (extract(dow FROM pt AT TIME ZONE 'Asia/Kolkata'))::smallint AS wd,
         (extract(hour FROM pt AT TIME ZONE 'Asia/Kolkata') * 4
           + floor(extract(minute FROM pt AT TIME ZONE 'Asia/Kolkata') / 15))::smallint AS tod,
         ((s - ps) / extract(epoch FROM recorded_at - pt) * 3.6)::real AS kmh
    FROM p
   WHERE ps IS NOT NULL
     AND s - ps >= 1
     AND recorded_at - pt BETWEEN interval '1 second' AND interval '60 seconds';
  DELETE FROM _speed_samples WHERE kmh > 100;  -- a GPS spike, not a bus

  SELECT count(*) INTO n FROM _speed_samples;
  UPDATE segment_speed_runs SET samples = n WHERE service_date = day;

  WITH rungs AS (
    SELECT lin, seg, wd AS weekday, tod, kmh FROM _speed_samples
    UNION ALL
    SELECT lin, seg, (CASE WHEN wd IN (0, 6) THEN 8 ELSE 7 END)::smallint, tod, kmh FROM _speed_samples
    UNION ALL
    SELECT lin, seg, NULL::smallint, tod, kmh FROM _speed_samples
    UNION ALL
    SELECT lin, seg, NULL::smallint, NULL::smallint, kmh FROM _speed_samples
  ), agg AS (
    SELECT lin, seg, weekday, tod,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY kmh)::real AS med,
           percentile_cont(0.1) WITHIN GROUP (ORDER BY kmh)::real AS p10,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY kmh)::real AS p90,
           count(*)::int AS cnt
      FROM rungs GROUP BY lin, seg, weekday, tod
  )
  INSERT INTO segment_speeds AS ss
         (route_lineage_id, segment_idx, weekday, tod_bucket, median_kmh, p10_kmh, p90_kmh, sample_count)
  SELECT lin, seg, weekday, tod, med, p10, p90, cnt FROM agg
  ON CONFLICT (route_lineage_id, segment_idx, COALESCE(weekday, -1), COALESCE(tod_bucket, -1))
  DO UPDATE SET
    median_kmh   = (ss.median_kmh * ss.sample_count + EXCLUDED.median_kmh * EXCLUDED.sample_count)
                   / (ss.sample_count + EXCLUDED.sample_count),
    p10_kmh      = (ss.p10_kmh * ss.sample_count + EXCLUDED.p10_kmh * EXCLUDED.sample_count)
                   / (ss.sample_count + EXCLUDED.sample_count),
    p90_kmh      = (ss.p90_kmh * ss.sample_count + EXCLUDED.p90_kmh * EXCLUDED.sample_count)
                   / (ss.sample_count + EXCLUDED.sample_count),
    sample_count = ss.sample_count + EXCLUDED.sample_count,
    updated_at   = now();
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION aggregate_segment_speeds(date) FROM PUBLIC, anon, authenticated;

/*
 * The nightly entry point: every day of the last two weeks that has trips and has not been
 * aggregated. A job that failed for three nights catches up on the fourth instead of leaving
 * holes that the partition drop would later make permanent.
 */
CREATE FUNCTION aggregate_segment_speeds_catchup(days integer DEFAULT 14) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d date;
  total integer := 0;
BEGIN
  FOR d IN
    SELECT DISTINCT t.service_date FROM trips t
     WHERE t.service_date < operating_date()
       AND t.service_date >= operating_date() - days
       AND NOT EXISTS (SELECT 1 FROM segment_speed_runs r WHERE r.service_date = t.service_date)
     ORDER BY 1
  LOOP
    total := total + aggregate_segment_speeds(d);
  END LOOP;
  RETURN total;
END $$;
REVOKE ALL ON FUNCTION aggregate_segment_speeds_catchup(integer) FROM PUBLIC, anon, authenticated;

-- ── stop search: a phonetic key for Indian place names (BUILD_PLAN Stage 5) ──
-- Hyderabad names are typed the way they sound, and romanised several ways at once:
-- "Kothi"/"Koti", "Dilshuknagar"/"Dilsukhnagar", "Ameerpet"/"Amirpet". Trigrams alone rank
-- "kothi" nearer "Kothapet" than "Koti". Folding aspirates (kh→k, th→t, …), doubled letters
-- and long vowels on both sides before comparing makes those the same word.
CREATE FUNCTION fold_place(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(lower(t), '([kgcjtdpbs])h', '\1', 'g'),   -- aspirates and sh
             'ee|ii', 'i', 'g'),
           'oo|uu', 'u', 'g'),
         '([a-z])\1+', '\1', 'g')                                        -- aa, tt, ll …
$$;

-- ── student relationships (SCHEMA §5) ─────────────────────────────────────

CREATE TABLE trip_subscriptions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  trip_id               uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  target_stop_id        uuid NOT NULL REFERENCES stops(id),
  state                 sub_state_t NOT NULL DEFAULT 'active',
  travel_time_s         integer CHECK (travel_time_s >= 0),
  travel_mode           travel_mode_t NOT NULL DEFAULT 'foot',
  buffer_s              integer NOT NULL DEFAULT 180 CHECK (buffer_s BETWEEN 0 AND 3600),
  notified_departure_at timestamptz,   -- "leave now" fired — fires at most once
  boarded_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, trip_id)
);
-- the leave-now ticker's whole working set; rows leave it the moment they fire
CREATE INDEX subs_active ON trip_subscriptions (trip_id)
  WHERE state = 'active' AND notified_departure_at IS NULL;
CREATE INDEX ON trip_subscriptions (user_id, created_at DESC);

CREATE TABLE walk_eta_cache (
  user_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  stop_id     uuid NOT NULL REFERENCES stops(id) ON DELETE CASCADE,
  travel_mode travel_mode_t NOT NULL,
  duration_s  integer NOT NULL CHECK (duration_s >= 0),
  distance_m  integer NOT NULL CHECK (distance_m >= 0),
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, stop_id, travel_mode)
);

-- ── predicted vs actual (BUILD_PLAN Stage 5 "Validate ETA accuracy against reality") ──

CREATE TABLE eta_predictions (
  trip_id              uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  seq                  smallint NOT NULL,
  stop_id              uuid NOT NULL REFERENCES stops(id),
  horizon_s            integer NOT NULL,  -- 600 / 300 / 120: logged once, as p50 enters the bucket
  predicted_at         timestamptz NOT NULL,
  p50_s                integer NOT NULL,
  p90_s                integer NOT NULL,
  confidence           text NOT NULL,
  rung                 smallint,          -- best v_hist rung used (1 exact … 4 any), NULL = cold start
  predicted_arrival_at timestamptz NOT NULL,
  actual_arrival_at    timestamptz,       -- set when trip_stop_events records the arrival
  error_s              integer GENERATED ALWAYS AS
                         (EXTRACT(epoch FROM actual_arrival_at - predicted_arrival_at)::integer) STORED,
  PRIMARY KEY (trip_id, seq, horizon_s)
);
CREATE INDEX ON eta_predictions (predicted_at DESC);

-- ── home pin: coarsened by the database (ARCH §10) ────────────────────────
-- ~100 m is ample for a walking ETA, and it means no client, bug or future code path can store
-- a student's exact front door. 0.001° is ~111 m of latitude, ~106 m of longitude at 17° N.
CREATE FUNCTION coarsen_home_location() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.home_location IS NOT NULL THEN
    NEW.home_location := ST_SetSRID(ST_MakePoint(
      round(ST_X(NEW.home_location::geometry)::numeric, 3),
      round(ST_Y(NEW.home_location::geometry)::numeric, 3)), 4326)::geography;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER profiles_coarsen_home BEFORE INSERT OR UPDATE OF home_location ON profiles
  FOR EACH ROW EXECUTE FUNCTION coarsen_home_location();

-- a moved pin or a new travel mode makes every cached walk wrong
CREATE FUNCTION invalidate_walk_cache() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.home_location IS DISTINCT FROM OLD.home_location
     OR NEW.travel_mode IS DISTINCT FROM OLD.travel_mode THEN
    DELETE FROM walk_eta_cache WHERE user_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER profiles_invalidate_walk AFTER UPDATE OF home_location, travel_mode ON profiles
  FOR EACH ROW EXECUTE FUNCTION invalidate_walk_cache();

-- ── row-level security (SCHEMA §9) ────────────────────────────────────────

ALTER TABLE segment_speeds     ENABLE ROW LEVEL SECURITY;
ALTER TABLE segment_speed_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE trip_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE walk_eta_cache     ENABLE ROW LEVEL SECURITY;
ALTER TABLE eta_predictions    ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON segment_speeds, segment_speed_runs, trip_subscriptions, walk_eta_cache,
              eta_predictions FROM anon, authenticated;

-- the traffic model and its accuracy are operational data: admins read, the engine writes
GRANT SELECT ON segment_speeds, segment_speed_runs, eta_predictions TO authenticated;
CREATE POLICY segment_speeds_admin ON segment_speeds FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY segment_speed_runs_admin ON segment_speed_runs FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY eta_predictions_admin ON eta_predictions FOR SELECT TO authenticated USING (is_admin());

-- a student's subscriptions and walking times are theirs alone; admins do not read them (privacy)
GRANT SELECT, INSERT, UPDATE, DELETE ON trip_subscriptions TO authenticated;
CREATE POLICY trip_subscriptions_own ON trip_subscriptions FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
GRANT SELECT ON walk_eta_cache TO authenticated;
CREATE POLICY walk_eta_cache_own ON walk_eta_cache FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- positions: the policy 0004 deferred — a student reads the last 24 h of trips they follow
CREATE POLICY positions_subscriber_read ON positions FOR SELECT TO authenticated
  USING (recorded_at > now() - interval '24 hours'
         AND EXISTS (SELECT 1 FROM trip_subscriptions s
                      WHERE s.trip_id = positions.trip_id AND s.user_id = auth.uid()));

-- ── scheduling ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron')
     AND current_database() = COALESCE(current_setting('cron.database_name', true), 'postgres') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    -- 01:30 IST: learn from every unaggregated day of the last fortnight
    PERFORM cron.schedule('aggregate-segment-speeds', '0 20 * * *',
      'SELECT public.aggregate_segment_speeds_catchup()');
    -- 02:00 IST: only now may old partitions go (0004 left this unscheduled until the
    -- aggregation that learns from them existed). Retention is 90 days; catch-up covers 14.
    PERFORM cron.schedule('drop-expired-positions', '30 20 * * *',
      'SELECT public.drop_expired_positions_partitions()');
  END IF;
END $$;
