-- 0009 — Stage 8, learning and observability (SCHEMA §3, §13; ARCHITECTURE §5.7, §12).
--
-- Three things:
--   * dead_zones can be *retired* rather than deleted: signal_outages.dead_zone_id points at the
--     zone an outage was explained by at the time, and that history must survive the zone
--     disappearing (a new tower, a re-routed road). Classification ignores retired zones.
--   * an outage whose trip ends while the bus is still silent is closed by the trip's end, with
--     no exit point — before this, the row stayed open for ever (M07 carried forward). Such a row
--     is not a dead zone observation: the learner only reads outages that really recovered.
--   * aggregate-only views for the dashboards, readable by a metrics role that sees no student,
--     driver or position row.

-- ── dead zones: retire, never delete ──────────────────────────────────────

ALTER TABLE dead_zones ADD COLUMN retired_at timestamptz;
-- the learner's run that last confirmed the zone (NULL for a hand-made zone)
ALTER TABLE dead_zones ADD COLUMN learned_at timestamptz;
CREATE INDEX dead_zones_active ON dead_zones USING GIST (polygon) WHERE retired_at IS NULL;

-- ── an outage ends with its trip ──────────────────────────────────────────

CREATE FUNCTION close_outages_on_trip_end() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('completed', 'cancelled') AND OLD.status IS DISTINCT FROM NEW.status THEN
    -- exit_point stays NULL: the bus never came back, so this is not a dead-zone observation
    UPDATE signal_outages
       SET recovered_at = GREATEST(COALESCE(NEW.ended_at, now()), started_at)
     WHERE trip_id = NEW.id AND recovered_at IS NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trips_close_outages AFTER UPDATE OF status ON trips
  FOR EACH ROW EXECUTE FUNCTION close_outages_on_trip_end();

-- rows left open by trips that had already ended before this migration
UPDATE signal_outages o
   SET recovered_at = GREATEST(COALESCE(t.ended_at, t.updated_at), o.started_at)
  FROM trips t
 WHERE t.id = o.trip_id AND o.recovered_at IS NULL AND t.status IN ('completed', 'cancelled');

-- ── dashboard views (aggregates only) ─────────────────────────────────────
-- Views run with their owner's rights, so the metrics role reads these without any grant on the
-- underlying tables — and the tables hold students and positions, which it must never see.

-- ETA accuracy by route lineage, IST hour and horizon (the Stage 5 gate is horizon 600)
CREATE VIEW obs_eta_accuracy AS
SELECT date_trunc('hour', p.predicted_at) AS hour,
       r.lineage_id,
       r.name AS route_name,
       p.horizon_s,
       count(*)::int AS n,
       round(avg(abs(p.error_s)))::int AS mae_s,
       round(avg(p.error_s))::int AS bias_s
  FROM eta_predictions p
  JOIN trips t ON t.id = p.trip_id
  JOIN routes r ON r.id = t.route_id
 WHERE p.error_s IS NOT NULL
 GROUP BY 1, 2, 3, 4;

-- notification delivery by hour, tier and channel (ARCH §6.3)
CREATE VIEW obs_notification_delivery AS
SELECT date_trunc('hour', r.queued_at) AS hour,
       n.tier,
       n.category::text AS category,
       COALESCE(r.channel::text, 'undecided') AS channel,
       count(*)::int AS recipients,
       count(r.sent_at)::int AS attempted,
       count(r.delivered_at)::int AS delivered,
       count(*) FILTER (WHERE r.failure_reason IS NOT NULL AND r.channel <> 'inapp_only')::int AS failed,
       count(*) FILTER (WHERE r.sent_at IS NULL)::int AS pending,
       round(percentile_cont(0.95) WITHIN GROUP
             (ORDER BY EXTRACT(epoch FROM r.delivered_at - n.created_at)))::int AS p95_deliver_s
  FROM notification_recipients r
  JOIN notifications n ON n.id = r.notification_id
 GROUP BY 1, 2, 3, 4;

-- signal outages per day: explained by a known zone or not, and how long they lasted
CREATE VIEW obs_signal_outages AS
SELECT date_trunc('day', o.started_at) AS day,
       (o.dead_zone_id IS NOT NULL) AS in_known_zone,
       (o.exit_point IS NOT NULL) AS recovered,
       count(*)::int AS outages,
       round(avg(o.duration_s))::int AS avg_s,
       max(o.duration_s)::int AS max_s
  FROM signal_outages o
 GROUP BY 1, 2, 3;

-- learned dead zones, for the map overlay and the frequency panel
CREATE VIEW obs_dead_zones AS
SELECT z.id, z.label, z.route_lineage_id, z.sample_count, z.avg_outage_s, z.p90_outage_s,
       z.confidence, z.last_observed_at, z.learned_at, z.retired_at,
       ST_AsGeoJSON(z.polygon)::jsonb AS polygon,
       (SELECT count(*)::int FROM signal_outages o
         WHERE o.dead_zone_id = z.id AND o.started_at > now() - interval '14 days') AS outages_14d
  FROM dead_zones z;

-- the metrics role: created without a login; the operator gives it one (runbook), never the repo
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'busmitra_metrics') THEN
    CREATE ROLE busmitra_metrics NOLOGIN;
  END IF;
END $$;
REVOKE ALL ON obs_eta_accuracy, obs_notification_delivery, obs_signal_outages, obs_dead_zones
  FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO busmitra_metrics;
GRANT SELECT ON obs_eta_accuracy, obs_notification_delivery, obs_signal_outages, obs_dead_zones
  TO busmitra_metrics;
