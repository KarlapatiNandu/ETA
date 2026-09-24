import type { TravelMode, WalkEta } from "@busmitra/contracts";
import type { Queryable } from "@busmitra/db";
import type { Osrm } from "./osrm.ts";

/**
 * Home → stop travel time (BUILD_PLAN Stage 5 "Walking ETA"), by the student's travel mode:
 *
 *   foot        OSRM `foot` profile duration
 *   bicycle     the foot route's distance at 15 km/h (there is no bicycle graph; paths a
 *               cyclist uses in Hyderabad are the ones a pedestrian does, give or take)
 *   motorbike   OSRM `car` profile duration (free-flow, so optimistic in traffic)
 *   car         OSRM `car` profile duration
 *
 * Cached in walk_eta_cache per (student, stop, mode) and refreshed after 24 h; the database
 * empties the cache the moment the pin or the mode changes (migration 0006 trigger). The home
 * is read from the database, where it is already coarsened to ~100 m.
 */

export const WALK = { CACHE_MS: 24 * 3600_000, BICYCLE_KMH: 15 } as const;

export interface TravelDeps {
  db: Queryable;
  foot?: Osrm;
  car?: Osrm;
  now?: () => number;
}

export async function travelTime(
  deps: TravelDeps,
  userId: string,
  stopId: string,
): Promise<WalkEta | null> {
  const now = (deps.now ?? Date.now)();
  const { rows } = await deps.db.query<{
    travel_mode: TravelMode;
    home_lat: number | null;
    home_lng: number | null;
    stop_lat: number;
    stop_lng: number;
    duration_s: number | null;
    distance_m: number | null;
    computed_at: Date | null;
  }>(
    `SELECT p.travel_mode,
            ST_Y(p.home_location::geometry) AS home_lat, ST_X(p.home_location::geometry) AS home_lng,
            ST_Y(s.location::geometry) AS stop_lat, ST_X(s.location::geometry) AS stop_lng,
            c.duration_s, c.distance_m, c.computed_at
       FROM profiles p
       JOIN stops s ON s.id = $2
       LEFT JOIN walk_eta_cache c
         ON c.user_id = p.id AND c.stop_id = s.id AND c.travel_mode = p.travel_mode
      WHERE p.id = $1`,
    [userId, stopId],
  );
  const r = rows[0];
  if (!r || r.home_lat === null || r.home_lng === null) return null;
  if (r.computed_at && now - new Date(r.computed_at).getTime() < WALK.CACHE_MS) {
    return {
      mode: r.travel_mode,
      durationS: Number(r.duration_s),
      distanceM: Number(r.distance_m),
      computedAt: new Date(r.computed_at).toISOString(),
    };
  }
  const home = { lat: Number(r.home_lat), lng: Number(r.home_lng) };
  const stop = { lat: Number(r.stop_lat), lng: Number(r.stop_lng) };
  const byCar = r.travel_mode === "car" || r.travel_mode === "motorbike";
  const osrm = byCar ? deps.car : deps.foot;
  if (!osrm) return null;
  let route;
  try {
    route = await osrm.route([home, stop]);
  } catch {
    return null; // OSRM down: no travel time is honest; a guessed one is not
  }
  const durationS = Math.round(
    r.travel_mode === "bicycle" ? route.distanceM / (WALK.BICYCLE_KMH / 3.6) : route.durationS,
  );
  const distanceM = Math.round(route.distanceM);
  await deps.db.query(
    `INSERT INTO walk_eta_cache (user_id, stop_id, travel_mode, duration_s, distance_m, computed_at)
     VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0))
     ON CONFLICT (user_id, stop_id, travel_mode)
     DO UPDATE SET duration_s = EXCLUDED.duration_s, distance_m = EXCLUDED.distance_m,
                   computed_at = EXCLUDED.computed_at`,
    [userId, stopId, r.travel_mode, durationS, distanceM, now],
  );
  return { mode: r.travel_mode, durationS, distanceM, computedAt: new Date(now).toISOString() };
}
