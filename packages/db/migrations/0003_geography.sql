-- 0003 — geography and fleet (SCHEMA §2, §3). Stage 1.
--
-- buses and trackers land here rather than with ingestion (0004) because the route survey is
-- uploaded by a paired tracker: survey mode authenticates with the same per-device HMAC as
-- ingest, so trackers must exist before route_surveys can reference them.

CREATE TYPE survey_status_t AS ENUM ('uploaded', 'matched', 'discarded');

-- ── routes ────────────────────────────────────────────────────────────────

CREATE TABLE routes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lineage_id        uuid NOT NULL,          -- stable across versions (SCHEMA §3, invariant 7)
  name              text NOT NULL,
  direction         direction_t NOT NULL,
  geometry          geography(LineString, 4326) NOT NULL,
  cumulative_dist_m double precision[] NOT NULL DEFAULT '{}',  -- derived by trigger
  total_distance_m  double precision NOT NULL DEFAULT 0,       -- derived by trigger
  version           integer NOT NULL DEFAULT 1,
  published_at      timestamptz,
  source            route_source_t NOT NULL,
  archived_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, direction, version)
);
CREATE INDEX ON routes USING GIST (geometry);
CREATE INDEX ON routes (lineage_id, version DESC);
CREATE UNIQUE INDEX one_live_route ON routes (lineage_id)
  WHERE published_at IS NOT NULL AND archived_at IS NULL;

-- D[] and the total, rebuilt whenever the geometry changes (ARCH §5.1). Distances are on the
-- sphere (use_spheroid = false) to match packages/geo exactly: the spheroid differs by ~0.3%,
-- which over a 25 km route is 75 m of disagreement between a stop offset and a bus offset.
CREATE FUNCTION routes_derive_distances() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND ST_AsBinary(NEW.geometry) = ST_AsBinary(OLD.geometry)
     AND NEW.cumulative_dist_m = OLD.cumulative_dist_m THEN
    RETURN NEW;
  END IF;
  SELECT array_agg(c ORDER BY n) INTO NEW.cumulative_dist_m
    FROM (
      SELECT n, COALESCE(sum(seg) OVER (ORDER BY n), 0) AS c
        FROM (
          SELECT dp.path[1] AS n,
                 ST_Distance(lag(dp.geom) OVER (ORDER BY dp.path[1])::geography,
                             dp.geom::geography, false) AS seg
            FROM ST_DumpPoints(NEW.geometry::geometry) AS dp
        ) segs
    ) cum;
  NEW.total_distance_m := NEW.cumulative_dist_m[array_length(NEW.cumulative_dist_m, 1)];
  RETURN NEW;
END $$;
CREATE TRIGGER routes_derive BEFORE INSERT OR UPDATE ON routes
  FOR EACH ROW EXECUTE FUNCTION routes_derive_distances();

-- A published route is immutable: a correction is version + 1 as a new row (ADR-0003), so a
-- three-month-old trip still resolves the geometry it ran. The only permitted change to a
-- published row is archiving it (superseded or retired).
CREATE FUNCTION routes_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.published_at IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'route % is published and cannot be deleted; archive it', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - 'archived_at') IS DISTINCT FROM (to_jsonb(OLD) - 'archived_at') THEN
    RAISE EXCEPTION 'route % is published and immutable; create a new version', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER routes_immutable BEFORE UPDATE OR DELETE ON routes
  FOR EACH ROW EXECUTE FUNCTION routes_guard();

-- ── stops ─────────────────────────────────────────────────────────────────

CREATE TABLE stops (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  aliases           text[] NOT NULL DEFAULT '{}',
  area_name         text,
  landmark          text,
  location          geography(Point, 4326) NOT NULL,
  geofence_radius_m smallint NOT NULL DEFAULT 80,
  archived_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON stops USING GIST (location);
CREATE INDEX stops_name_trgm ON stops USING GIN (name gin_trgm_ops);
CREATE INDEX stops_area_trgm ON stops USING GIN (area_name gin_trgm_ops);
CREATE INDEX stops_aliases_gin ON stops USING GIN (aliases);
CREATE TRIGGER stops_updated_at BEFORE UPDATE ON stops
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- No UNIQUE (route_id, stop_id): a circular route may serve the same stop twice (SCHEMA §3).
CREATE TABLE route_stops (
  route_id            uuid NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  seq                 smallint NOT NULL,
  stop_id             uuid NOT NULL REFERENCES stops(id),
  cumulative_dist_m   double precision NOT NULL,
  scheduled_offset_s  integer,
  expected_dwell_s    smallint NOT NULL DEFAULT 30,
  PRIMARY KEY (route_id, seq)
);
CREATE INDEX ON route_stops (stop_id);

-- a published route's stops are frozen with it
CREATE FUNCTION route_stops_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  rid uuid := COALESCE(NEW.route_id, OLD.route_id);
BEGIN
  IF EXISTS (SELECT 1 FROM routes WHERE id = rid AND published_at IS NOT NULL) THEN
    RAISE EXCEPTION 'route % is published; its stops are frozen', rid
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER route_stops_frozen BEFORE INSERT OR UPDATE OR DELETE ON route_stops
  FOR EACH ROW EXECUTE FUNCTION route_stops_guard();

-- ── fleet (SCHEMA §2) ─────────────────────────────────────────────────────

CREATE TABLE buses (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bus_number       text NOT NULL UNIQUE,
  registration_no  text UNIQUE,
  capacity         smallint,
  status           bus_status_t NOT NULL DEFAULT 'active',
  status_note      text,
  default_route_id uuid REFERENCES routes(id),
  archived_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER buses_updated_at BEFORE UPDATE ON buses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- secret_enc is pgp_sym_encrypt'd, never hashed (invariant 6): verifying an HMAC needs the
-- plaintext. The key lives in the gateway environment (TRACKER_SECRET_KEY), never here.
-- secret_prev_enc holds the previous secret so both verify for 10 minutes after a rotation.
CREATE TABLE trackers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_uid        text NOT NULL UNIQUE,
  kind              tracker_kind_t NOT NULL,
  bus_id            uuid REFERENCES buses(id),
  secret_enc        bytea NOT NULL,
  secret_prev_enc   bytea,
  secret_rotated_at timestamptz,
  cadence_s         smallint NOT NULL DEFAULT 5,
  firmware          text,
  last_seen_at      timestamptz,
  battery_pct       smallint,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON trackers (bus_id) WHERE bus_id IS NOT NULL;

-- ── route surveys (Stage 1 route capture) ────────────────────────────────

CREATE TABLE route_surveys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tracker_id   uuid NOT NULL REFERENCES trackers(id),
  bus_id       uuid REFERENCES buses(id),
  label        text,                     -- what the surveyor typed on the phone
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz NOT NULL,
  point_count  integer NOT NULL,
  file_path    text NOT NULL,            -- raw 1 Hz trace in Storage (route-surveys bucket)
  status       survey_status_t NOT NULL DEFAULT 'uploaded',
  route_id     uuid REFERENCES routes(id),  -- the draft the pipeline produced
  match_report jsonb,                    -- {chunks, gaps, matchedPct, simplifiedTo}
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON route_surveys (created_at DESC);

-- ── audit (SCHEMA §8) — geometry and secrets never reach the audit log ───

-- audit_row() from 0002 read NEW.id in its profiles check. PL/pgSQL resolves record fields
-- even when an earlier AND operand is false, so on a table with no `id` column (route_stops)
-- every write failed with 'record "new" has no field "id"'. Read the id from the jsonb image.
CREATE OR REPLACE FUNCTION audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  candidate uuid := COALESCE(auth.uid(), NULLIF(current_setting('app.actor_id', true), '')::uuid);
  actor     uuid;
  b jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  a jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  col text;
BEGIN
  -- a student editing their own preferences is not an admin action
  IF TG_TABLE_NAME = 'profiles' AND TG_OP = 'UPDATE' AND candidate = (a->>'id')::uuid THEN
    RETURN NEW;
  END IF;
  SELECT id INTO actor FROM profiles WHERE id = candidate;
  -- TG_ARGV is NULL, not '{}', for a trigger declared without arguments
  FOREACH col IN ARRAY COALESCE(TG_ARGV, '{}') LOOP
    b := b - col;
    a := a - col;
  END LOOP;
  INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after, ip, user_agent)
  VALUES (
    actor,
    TG_TABLE_NAME || '.' || lower(TG_OP),
    TG_TABLE_NAME,
    COALESCE((a->>'id')::uuid, (b->>'id')::uuid),
    b, a,
    NULLIF(current_setting('app.client_ip', true), '')::inet,
    NULLIF(current_setting('app.user_agent', true), '')
  );
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER audit_routes AFTER INSERT OR UPDATE OR DELETE ON routes
  FOR EACH ROW EXECUTE FUNCTION audit_row('geometry', 'cumulative_dist_m');
CREATE TRIGGER audit_stops AFTER INSERT OR UPDATE OR DELETE ON stops
  FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit_route_stops AFTER INSERT OR UPDATE OR DELETE ON route_stops
  FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit_buses AFTER INSERT OR UPDATE OR DELETE ON buses
  FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit_trackers AFTER INSERT OR UPDATE OR DELETE ON trackers
  FOR EACH ROW EXECUTE FUNCTION audit_row('secret_enc', 'secret_prev_enc');
CREATE TRIGGER audit_route_surveys AFTER UPDATE OR DELETE ON route_surveys
  FOR EACH ROW EXECUTE FUNCTION audit_row();

-- ── row-level security (SCHEMA §9) — deny by default ──────────────────────

ALTER TABLE routes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE stops         ENABLE ROW LEVEL SECURITY;
ALTER TABLE route_stops   ENABLE ROW LEVEL SECURITY;
ALTER TABLE buses         ENABLE ROW LEVEL SECURITY;
ALTER TABLE trackers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE route_surveys ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON routes, stops, route_stops, buses, trackers, route_surveys FROM anon, authenticated;

-- routes: students read published, non-archived versions; drafts are admin-only
GRANT SELECT, INSERT, UPDATE, DELETE ON routes TO authenticated;
CREATE POLICY routes_read ON routes FOR SELECT TO authenticated
  USING ((published_at IS NOT NULL AND archived_at IS NULL) OR is_admin());
CREATE POLICY routes_admin ON routes FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON stops TO authenticated;
CREATE POLICY stops_read ON stops FOR SELECT TO authenticated
  USING (archived_at IS NULL OR is_admin());
CREATE POLICY stops_admin ON stops FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON route_stops TO authenticated;
CREATE POLICY route_stops_read ON route_stops FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM routes r WHERE r.id = route_id));  -- routes' own policy applies
CREATE POLICY route_stops_admin ON route_stops FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON buses TO authenticated;
CREATE POLICY buses_read ON buses FOR SELECT TO authenticated
  USING (archived_at IS NULL OR is_admin());
CREATE POLICY buses_admin ON buses FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

-- trackers: admins may read the non-secret columns. Nobody — admin included — can read a
-- secret through the API ("never returned to any client after issue", ARCH §10), and
-- provisioning/rotation are service-role operations.
GRANT SELECT (id, device_uid, kind, bus_id, secret_rotated_at, cadence_s, firmware,
              last_seen_at, battery_pct, created_at) ON trackers TO authenticated;
CREATE POLICY trackers_admin_read ON trackers FOR SELECT TO authenticated USING (is_admin());

GRANT SELECT, UPDATE ON route_surveys TO authenticated;
CREATE POLICY route_surveys_admin ON route_surveys FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());
