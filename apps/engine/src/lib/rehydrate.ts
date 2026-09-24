import type { Queryable } from "@busmitra/db";
import { writeFleetIfNewer, type FleetEntry, type Keys, type Redis } from "@busmitra/redis";
import { judgePresence } from "../workers/presence.ts";
import type { RouteCache } from "./route-cache.ts";

/**
 * ADR-0002: Redis is the live fleet, Postgres the record. When Redis comes up empty (a flush, a
 * new instance), refill `fleet:live` from the last five minutes of `positions`, so a restart
 * does not blank the map for every student at once.
 *
 * Each entry is written with the presence its age already implies — a fix four minutes old is
 * DARK, not LIVE (invariant 2) — and only where nothing newer is there (invariant 4), so running
 * this against a healthy Redis changes nothing.
 */
export async function rehydrateFleet(
  db: Queryable,
  redis: Redis,
  keys: Keys,
  routes: RouteCache,
  now: number = Date.now(),
): Promise<number> {
  const { rows } = await db.query<{
    trip_id: string;
    bus_id: string;
    route_id: string;
    recorded_at: Date;
    lat: number;
    lng: number;
    speed_kmh: number | null;
    heading_deg: number | null;
    route_offset_m: number | null;
    cadence_s: number | null;
  }>(
    `SELECT DISTINCT ON (p.trip_id) p.trip_id, p.bus_id, t.route_id, p.recorded_at,
            ST_Y(p.location::geometry) AS lat, ST_X(p.location::geometry) AS lng,
            p.speed_kmh, p.heading_deg, p.route_offset_m,
            (SELECT tr.cadence_s FROM trackers tr WHERE tr.bus_id = p.bus_id LIMIT 1) AS cadence_s
       FROM positions p JOIN trips t ON t.id = p.trip_id
      WHERE t.status IN ('running', 'dark')
        AND p.recorded_at > to_timestamp($1 / 1000.0) - interval '5 minutes'
      ORDER BY p.trip_id, p.recorded_at DESC`,
    [now],
  );
  let written = 0;
  for (const r of rows) {
    const loaded = await routes.get(r.route_id).catch(() => null);
    const s = r.route_offset_m === null ? null : Number(r.route_offset_m);
    const seq = s === null || !loaded ? -1 : loaded.stops.filter((st) => st.offset <= s).length - 1;
    const entry: FleetEntry = {
      lat: Number(r.lat),
      lng: Number(r.lng),
      spd: r.speed_kmh === null ? null : Number(r.speed_kmh),
      hdg: r.heading_deg,
      s,
      seq,
      tripId: r.trip_id,
      ts: new Date(r.recorded_at).toISOString(),
      state: "LIVE",
      cadence: r.cadence_s ?? 5,
      flag: "rehydrated",
      routeId: r.route_id,
    };
    entry.state = judgePresence(entry, now);
    if (await writeFleetIfNewer(redis, keys, r.bus_id, entry)) written++;
  }
  return written;
}
