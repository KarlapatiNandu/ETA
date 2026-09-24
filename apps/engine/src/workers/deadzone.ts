import type { Db, Queryable } from "@busmitra/db";
import { bufferedHull, centroid, dbscan, percentile, type LatLng } from "@busmitra/geo";

/**
 * engine/deadzone.ts (BUILD_PLAN Stage 8, ARCH §5.7): nightly DBSCAN over signal-outage entry
 * points → buffered convex hulls → `dead_zones`, which the presence sweeper already consults
 * when a bus goes DARK (`classifyDeadZone`). A recurring outage becomes "in a known dead zone
 * near Uppal, usually clears in about 90 s" (T4, in-app only) instead of a T2 push.
 *
 * What counts as an observation: an outage that **really recovered** (it has an exit point),
 * lasted no longer than MAX_OUTAGE_S, within the last WINDOW_DAYS. An outage closed by its trip's
 * end is a phone that died or a driver who ended the trip, not a place.
 *
 * A zone must be seen on at least MIN_TRIPS different trips: one flaky phone stuttering four
 * times on one trip is not a place either.
 *
 * Reconciliation keeps zone ids stable: a cluster that overlaps an existing learned zone updates
 * it in place (its admin label survives), a new cluster inserts, and a learned zone with no
 * support left in the window is *retired*, never deleted — `signal_outages.dead_zone_id` keeps
 * pointing at the zone that explained it (0009). Zones an admin drew (`learned_at IS NULL`) are
 * never touched. One advisory lock per run, so two engines cannot interleave; a run is a pure
 * function of the window, so running it twice changes nothing.
 */

export const DEADZONE = {
  EPS_M: 150,
  MIN_PTS: 4,
  /** around the hull: entry points are the last fix *before* the silence, up to one cadence early */
  BUFFER_M: 60,
  WINDOW_DAYS: 60,
  MAX_OUTAGE_S: 15 * 60,
  MIN_TRIPS: 2,
  /** local time the nightly run is due (IST), and how often the engine checks */
  RUN_AT_IST: "02:30",
  CHECK_EVERY_MS: 5 * 60_000,
} as const;

export interface Outage extends LatLng {
  id: string;
  tripId: string;
  lineageId: string;
  durationS: number;
  startedAt: string;
  /** service day, IST */
  day: string;
}

export interface Cluster {
  points: Outage[];
  ring: LatLng[];
  sampleCount: number;
  trips: number;
  days: number;
  avgOutageS: number;
  p90OutageS: number;
  /** 0..1: recurrence across days, discounted by how much of the cluster is only fringe */
  confidence: number;
  lastObservedAt: string;
  /** the lineage when every sample came from one route, else null (applies to any route) */
  lineageId: string | null;
}

/**
 * The pure half: outages in, zones out. Deterministic for a given input order (the loader sorts
 * by `started_at, id`), so the simulator-injected zones replay exactly (Stage 8 exit).
 */
export function clusterOutages(
  outages: readonly Outage[],
  o: { epsM?: number; minPts?: number; bufferM?: number; minTrips?: number } = {},
): Cluster[] {
  const eps = o.epsM ?? DEADZONE.EPS_M;
  const minPts = o.minPts ?? DEADZONE.MIN_PTS;
  const res = dbscan(outages, eps, minPts);
  const out: Cluster[] = [];
  for (let c = 0; c < res.count; c++) {
    const idx = res.labels.flatMap((l, i) => (l === c ? [i] : []));
    const points = idx.map((i) => outages[i]!);
    const trips = new Set(points.map((p) => p.tripId)).size;
    if (trips < (o.minTrips ?? DEADZONE.MIN_TRIPS)) continue;
    const days = new Set(points.map((p) => p.day)).size;
    const coreShare = idx.filter((i) => res.core[i]).length / idx.length;
    const durations = points.map((p) => p.durationS);
    const lineages = new Set(points.map((p) => p.lineageId));
    out.push({
      points,
      ring: bufferedHull(points, o.bufferM ?? DEADZONE.BUFFER_M),
      sampleCount: points.length,
      trips,
      days,
      avgOutageS: Math.round(durations.reduce((s, d) => s + d, 0) / durations.length),
      p90OutageS: percentile(durations, 90),
      // one day: 0.5 at best; three days: 0.875; the fringe share scales it down
      confidence: Math.round(coreShare * (1 - 0.5 ** days) * 1000) / 1000,
      lastObservedAt: points
        .map((p) => p.startedAt)
        .sort()
        .at(-1)!,
      lineageId: lineages.size === 1 ? points[0]!.lineageId : null,
    });
  }
  return out;
}

export function ringWkt(ring: readonly LatLng[]): string {
  return `POLYGON((${ring.map((p) => `${p.lng.toFixed(7)} ${p.lat.toFixed(7)}`).join(", ")}))`;
}

export async function loadOutages(q: Queryable, now: number): Promise<Outage[]> {
  const { rows } = await q.query<{
    id: string;
    trip_id: string;
    lineage_id: string;
    lat: number;
    lng: number;
    duration_s: number;
    started_at: Date;
    day: string;
  }>(
    `SELECT o.id, o.trip_id, r.lineage_id,
            ST_Y(o.entry_point::geometry) AS lat, ST_X(o.entry_point::geometry) AS lng,
            o.duration_s, o.started_at,
            to_char(o.started_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day
       FROM signal_outages o
       JOIN trips t ON t.id = o.trip_id
       JOIN routes r ON r.id = t.route_id
      WHERE o.exit_point IS NOT NULL AND o.recovered_at IS NOT NULL
        AND o.duration_s <= $2
        AND o.started_at > $1::timestamptz - make_interval(days => $3)
        AND o.started_at <= $1::timestamptz
      ORDER BY o.started_at, o.id`,
    [new Date(now).toISOString(), DEADZONE.MAX_OUTAGE_S, DEADZONE.WINDOW_DAYS],
  );
  return rows.map((r) => ({
    id: r.id,
    tripId: r.trip_id,
    lineageId: r.lineage_id,
    lat: Number(r.lat),
    lng: Number(r.lng),
    durationS: Number(r.duration_s),
    startedAt: new Date(r.started_at).toISOString(),
    day: r.day,
  }));
}

export interface LearnReport {
  outages: number;
  clusters: number;
  inserted: string[];
  updated: string[];
  retired: string[];
}

/** One run: load the window, cluster it, reconcile `dead_zones` — in one transaction. */
export async function learnDeadZones(db: Db, now: number = Date.now()): Promise<LearnReport> {
  return db.tx(async (q) => {
    await q.query(`SELECT pg_advisory_xact_lock(hashtext('busmitra:deadzone'))`);
    const outages = await loadOutages(q, now);
    const clusters = clusterOutages(outages);
    const at = new Date(now).toISOString();
    const report: LearnReport = {
      outages: outages.length,
      clusters: clusters.length,
      inserted: [],
      updated: [],
      retired: [],
    };
    const matched = new Set<string>();
    // biggest clusters claim their zone first, so a zone that split keeps its id on the main part
    for (const c of [...clusters].sort((a, b) => b.sampleCount - a.sampleCount)) {
      const wkt = ringWkt(c.ring);
      const hit = await q.query<{ id: string }>(
        `SELECT id FROM dead_zones
          WHERE retired_at IS NULL AND learned_at IS NOT NULL AND NOT (id = ANY($2::uuid[]))
            AND ST_Intersects(polygon, ST_GeogFromText($1))
          ORDER BY ST_Area(ST_Intersection(polygon::geometry, ST_GeomFromText($1, 4326))) DESC
          LIMIT 1`,
        [wkt, [...matched]],
      );
      const params = [
        wkt,
        c.lineageId,
        c.sampleCount,
        c.avgOutageS,
        c.p90OutageS,
        c.confidence,
        c.lastObservedAt,
        at,
      ];
      if (hit.rows[0]) {
        const id = hit.rows[0].id;
        matched.add(id);
        await q.query(
          `UPDATE dead_zones SET polygon = ST_GeogFromText($1), route_lineage_id = $2,
                  sample_count = $3, avg_outage_s = $4, p90_outage_s = $5, confidence = $6,
                  last_observed_at = $7, learned_at = $8
            WHERE id = $9`,
          [...params, id],
        );
        report.updated.push(id);
      } else {
        // labelled after the nearest stop, so the student reads "near Uppal X Roads"; an admin
        // can rename it, and the rename survives every later run
        const center = centroid(c.points);
        const ins = await q.query<{ id: string }>(
          `INSERT INTO dead_zones (polygon, route_lineage_id, sample_count, avg_outage_s,
                                   p90_outage_s, confidence, last_observed_at, learned_at, label)
           VALUES (ST_GeogFromText($1), $2, $3, $4, $5, $6, $7, $8,
                   (SELECT s.name FROM stops s WHERE s.archived_at IS NULL
                       AND ST_DWithin(s.location, ST_SetSRID(ST_MakePoint($9, $10), 4326)::geography, 1500)
                     ORDER BY s.location <-> ST_SetSRID(ST_MakePoint($9, $10), 4326)::geography
                     LIMIT 1))
           RETURNING id`,
          [...params, center.lng, center.lat],
        );
        matched.add(ins.rows[0]!.id);
        report.inserted.push(ins.rows[0]!.id);
      }
    }
    const retired = await q.query<{ id: string }>(
      `UPDATE dead_zones SET retired_at = $1
        WHERE retired_at IS NULL AND learned_at IS NOT NULL AND NOT (id = ANY($2::uuid[]))
        RETURNING id`,
      [at, [...matched]],
    );
    report.retired = retired.rows.map((r) => r.id);
    return report;
  });
}

/** Whether the nightly run is due: past RUN_AT_IST today (IST) and not yet run today. */
export function nightlyDue(now: number, lastRunDay: string | null): { due: boolean; day: string } {
  const ist = new Date(now + 5.5 * 3600_000);
  const day = ist.toISOString().slice(0, 10);
  const hhmm = ist.toISOString().slice(11, 16);
  return { due: hhmm >= DEADZONE.RUN_AT_IST && lastRunDay !== day, day };
}
