-- 0005 — Stage 3, live delivery (SCHEMA §3 dead zones and signal outages).
--
-- signal_outages is the raw observation log the presence sweeper writes on every DARK
-- transition (ARCH §5.7); dead_zones is what the nightly DBSCAN job (Stage 8) learns from it.
-- The table exists now because DARK classification reads it from the first day: with no rows,
-- every outage is honestly reported as "signal lost", which is the right cold start.

-- ── dead zones (learned, not configured) ─────────────────────────────────

CREATE TABLE dead_zones (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  polygon          geography(Polygon, 4326) NOT NULL,
  route_lineage_id uuid,                 -- lineage, not version: survives a re-survey (invariant 7)
  label            text,                 -- "Uppal flyover underpass"
  sample_count     integer NOT NULL,
  avg_outage_s     integer NOT NULL,
  p90_outage_s     integer NOT NULL,
  confidence       real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  last_observed_at timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON dead_zones USING GIST (polygon);

-- ── signal outages (the observation log) ─────────────────────────────────

CREATE TABLE signal_outages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id       uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  bus_id        uuid NOT NULL REFERENCES buses(id),
  entry_point   geography(Point, 4326) NOT NULL,
  exit_point    geography(Point, 4326),
  started_at    timestamptz NOT NULL,     -- the last fix before the silence, not the DARK moment
  recovered_at  timestamptz,
  duration_s    integer GENERATED ALWAYS AS
                  (EXTRACT(epoch FROM recovered_at - started_at)::integer) STORED,
  dead_zone_id  uuid REFERENCES dead_zones(id),  -- set if it matched a known zone
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON signal_outages USING GIST (entry_point);
CREATE INDEX ON signal_outages (trip_id);
-- one open outage per trip: a sweeper restarted mid-outage finds it instead of opening a second
CREATE UNIQUE INDEX one_open_outage ON signal_outages (trip_id) WHERE recovered_at IS NULL;

-- ── row-level security (SCHEMA §9) — deny by default ──────────────────────

ALTER TABLE dead_zones     ENABLE ROW LEVEL SECURITY;
ALTER TABLE signal_outages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON dead_zones, signal_outages FROM anon, authenticated;

-- students may read dead zones (the map explains a known one); admins manage them
GRANT SELECT, INSERT, UPDATE, DELETE ON dead_zones TO authenticated;
CREATE POLICY dead_zones_read ON dead_zones FOR SELECT TO authenticated USING (true);
CREATE POLICY dead_zones_admin ON dead_zones FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

-- outages are fleet telemetry: admins only
GRANT SELECT, INSERT, UPDATE, DELETE ON signal_outages TO authenticated;
CREATE POLICY signal_outages_admin ON signal_outages FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());
