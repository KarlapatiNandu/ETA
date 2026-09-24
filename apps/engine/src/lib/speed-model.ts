import type { Queryable } from "@busmitra/db";
import { ETA, pointAtOffset, resolveRung, type Route, type SegmentStat } from "@busmitra/geo";
import { TTL, type Keys, type Redis } from "@busmitra/redis";
import type { Osrm } from "../osrm.ts";

/**
 * The inputs ARCH §5.5 blends, per 200 m segment of a route:
 *
 *   v_hist  segment_speeds, resolved down the ladder for *this* weekday and quarter-hour
 *   v_osrm  OSRM's free-flow speed for that stretch of road
 *
 * (v_live, the bus's EWMA, comes from Redis per fix.) Both are cached: the history per lineage
 * for ten minutes (the nightly job is the only writer), the OSRM speeds per route version for a
 * day in Redis (a published route never changes).
 */

/** IST is UTC+5:30 all year (no DST): the weekday and 15-minute bucket of an instant. */
export function istBucket(epochMs: number): { weekday: number; tod: number } {
  const ist = new Date(epochMs + 5.5 * 3600_000);
  return {
    weekday: ist.getUTCDay(),
    tod: ist.getUTCHours() * 4 + Math.floor(ist.getUTCMinutes() / 15),
  };
}

type Rows = Map<string, SegmentStat>;
const key = (seg: number, wd: number | null, tod: number | null) =>
  `${seg}|${wd ?? "-"}|${tod ?? "-"}`;

export class HistoryCache {
  private readonly byLineage = new Map<string, { at: number; rows: Rows }>();
  private readonly db: Queryable;
  private readonly ttlMs: number;
  private readonly clock: () => number;
  /**
   * The cache ages on the wall clock, never on the fix's timestamp: a backfilled or replayed
   * fix is older than the last one, and ageing by it made the cache look fresh for as long as
   * the gap (found by eta.test.ts — history silently ignored after an out-of-order fix).
   */
  constructor(db: Queryable, ttlMs = 10 * 60_000, clock: () => number = Date.now) {
    this.db = db;
    this.ttlMs = ttlMs;
    this.clock = clock;
  }

  private async rows(lineageId: string): Promise<Rows> {
    const now = this.clock();
    const hit = this.byLineage.get(lineageId);
    if (hit && now >= hit.at && now - hit.at < this.ttlMs) return hit.rows;
    try {
      const { rows } = await this.db.query<{
        segment_idx: number;
        weekday: number | null;
        tod_bucket: number | null;
        median_kmh: number;
        p10_kmh: number;
        p90_kmh: number;
        sample_count: number;
      }>(
        `SELECT segment_idx, weekday, tod_bucket, median_kmh, p10_kmh, p90_kmh, sample_count
           FROM segment_speeds WHERE route_lineage_id = $1`,
        [lineageId],
      );
      const m: Rows = new Map();
      for (const r of rows)
        m.set(key(r.segment_idx, r.weekday, r.tod_bucket), {
          medianKmh: Number(r.median_kmh),
          p10Kmh: Number(r.p10_kmh),
          p90Kmh: Number(r.p90_kmh),
          sampleCount: Number(r.sample_count),
        });
      this.byLineage.set(lineageId, { at: now, rows: m });
      return m;
    } catch {
      // Postgres down: the last history we had, else cold start — never a failure (ARCH §11)
      return hit?.rows ?? new Map();
    }
  }

  /**
   * v_hist per segment, first rung with ≥ 5 samples: (day, tod) → (weekday class, tod) → (tod)
   * → (any). `rungs[seg]` says which rung answered (1–4), null for cold start.
   */
  async resolve(
    lineageId: string,
    segments: number,
    at: number,
  ): Promise<{ hist: (SegmentStat | null)[]; rungs: (number | null)[] }> {
    const rows = await this.rows(lineageId);
    const { weekday, tod } = istBucket(at);
    const klass = weekday === 0 || weekday === 6 ? 8 : 7;
    const hist: (SegmentStat | null)[] = [];
    const rungs: (number | null)[] = [];
    for (let seg = 0; seg < segments; seg++) {
      const r = resolveRung([
        rows.get(key(seg, weekday, tod)),
        rows.get(key(seg, klass, tod)),
        rows.get(key(seg, null, tod)),
        rows.get(key(seg, null, null)),
      ]);
      hist.push(r?.stat ?? null);
      rungs.push(r?.rung ?? null);
    }
    return { hist, rungs };
  }
}

/**
 * OSRM free-flow speed per 200 m segment: route through the route's own points every 200 m, and
 * read each leg's distance and duration. One call per route version, cached for a day.
 * An empty array (OSRM down) is an honest answer: computeEta falls back to history, then live.
 */
export async function osrmSegmentSpeeds(
  route: Route,
  routeId: string,
  deps: { redis: Redis; keys: Keys; osrm?: Osrm },
): Promise<(number | null)[]> {
  const cached = await deps.redis.get(deps.keys.routeOsrm(routeId));
  if (cached) return JSON.parse(cached) as (number | null)[];
  if (!deps.osrm) return [];
  const segments = Math.ceil(route.total / ETA.SEGMENT_M);
  const points = Array.from({ length: segments + 1 }, (_, i) =>
    pointAtOffset(route, Math.min(route.total, i * ETA.SEGMENT_M)),
  );
  const speeds: (number | null)[] = [];
  try {
    // OSRM caps waypoints per request; 90 segments (18 km) per call, legs joined end to end
    for (let from = 0; from < segments; from += 90) {
      const slice = points.slice(from, Math.min(points.length, from + 91));
      const r = await deps.osrm.route(slice);
      for (const leg of r.legs) {
        // a waypoint snapped onto the far carriageway makes a leg with a U-turn in it: no
        // speed for that segment is better than a wrong one
        const plausible =
          leg.durationS > 0 && leg.distanceM > 0 && leg.distanceM < 3 * ETA.SEGMENT_M;
        speeds.push(plausible ? (leg.distanceM / leg.durationS) * 3.6 : null);
      }
    }
  } catch {
    return []; // not cached: the next ETA pass tries again
  }
  await deps.redis.set(
    deps.keys.routeOsrm(routeId),
    JSON.stringify(speeds),
    "EX",
    TTL.ROUTE_OSRM_S,
  );
  return speeds;
}
