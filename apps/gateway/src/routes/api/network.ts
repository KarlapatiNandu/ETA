import type { FastifyInstance } from "fastify";
import type { Network } from "@busmitra/contracts";
import type { Queryable } from "@busmitra/db";
import { requireUser } from "../../plugins/auth.ts";

/**
 * GET /v1/network (Stage 3): what the student map draws — every published route with its
 * polyline, D[] and stops, and the fleet's bus numbers. Published routes are immutable, so a
 * one-minute cache in process memory costs nothing in freshness.
 */

const CACHE_MS = 60_000;
type Coord = [number, number];

export async function loadNetwork(db: Queryable): Promise<Network> {
  const routes = await db.query<{
    id: string;
    lineage_id: string;
    name: string;
    direction: "inbound" | "outbound";
    coords: Coord[];
    cum: number[];
  }>(
    `SELECT id, lineage_id, name, direction,
            (ST_AsGeoJSON(geometry, 6)::json -> 'coordinates') AS coords,
            cumulative_dist_m AS cum
       FROM routes WHERE published_at IS NOT NULL AND archived_at IS NULL
      ORDER BY name, direction`,
  );
  const stops = await db.query<{
    route_id: string;
    stop_id: string;
    seq: number;
    name: string;
    lat: number;
    lng: number;
    offset: number;
  }>(
    `SELECT rs.route_id, rs.stop_id, rs.seq, s.name,
            ST_Y(s.location::geometry) AS lat, ST_X(s.location::geometry) AS lng,
            rs.cumulative_dist_m AS offset
       FROM route_stops rs JOIN stops s ON s.id = rs.stop_id
       JOIN routes r ON r.id = rs.route_id
      WHERE r.published_at IS NOT NULL AND r.archived_at IS NULL
      ORDER BY rs.route_id, rs.seq`,
  );
  const buses = await db.query<{ id: string; bus_number: string; status: string }>(
    `SELECT id, bus_number, status FROM buses WHERE archived_at IS NULL ORDER BY bus_number`,
  );
  return {
    routes: routes.rows.map((r) => ({
      id: r.id,
      lineageId: r.lineage_id,
      name: r.name,
      direction: r.direction,
      coords: r.coords,
      cum: r.cum.map(Number),
      stops: stops.rows
        .filter((s) => s.route_id === r.id)
        .map((s) => ({
          stopId: s.stop_id,
          seq: Number(s.seq),
          name: s.name,
          lat: Number(s.lat),
          lng: Number(s.lng),
          offset: Number(s.offset),
        })),
    })),
    buses: buses.rows.map((b) => ({ id: b.id, number: b.bus_number, status: b.status })),
  };
}

export async function networkRoutes(
  app: FastifyInstance,
  deps: { db: Queryable; now?: () => number },
) {
  const now = deps.now ?? Date.now;
  let cached: { at: number; value: Network } | null = null;
  app.get("/v1/network", { preHandler: requireUser }, async (_req, reply) => {
    if (!cached || now() - cached.at > CACHE_MS) {
      try {
        cached = { at: now(), value: await loadNetwork(deps.db) };
      } catch (err) {
        // Postgres down: serve the last known network rather than an empty map (ARCH §11)
        if (!cached) throw err;
      }
    }
    reply.header("cache-control", "private, max-age=60");
    return cached.value;
  });
}
