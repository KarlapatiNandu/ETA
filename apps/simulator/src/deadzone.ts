import { PRESENCE } from "@busmitra/config";
import type { Db } from "@busmitra/db";
import { DEADZONE } from "@busmitra/engine/deadzone";
import { listRoutes, loadRoute, type LoadedRoute } from "@busmitra/engine/routes";
import { pointAtOffset, ringContains, haversine, type LatLng, type Route } from "@busmitra/geo";
import type { SimPing, SimTrip } from "./model.ts";
import { prng } from "./model.ts";

/**
 * Dead zones the simulator injects, and the check that the Stage 8 learner found them
 * (BUILD_PLAN Stage 8 exit: "DBSCAN clustering verified against simulator-injected dead zones").
 *
 * Zones belong to a *route*, not to a bus: a dead zone is a place, and every bus that drives
 * through it goes quiet there. (Stages 1–3 seeded them per bus, which was enough to exercise
 * presence but gives the learner nothing that recurs.)
 */

/** 1–2 deterministic dead zones per route, 400–900 m long, away from the ends. */
export function deadZonesFor(route: Route, seed: number): [number, number][] {
  const rng = prng(seed);
  const n = 1 + Math.floor(rng() * 2);
  return Array.from({ length: n }, () => {
    const start = route.total * (0.15 + rng() * 0.6);
    return [start, start + 400 + rng() * 500] as [number, number];
  });
}

/** The seed a route's zones come from: stable across runs, buses and route versions. */
export function routeZoneSeed(lineageId: string, seed = 1): number {
  let h = 2166136261;
  for (const ch of lineageId) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0) ^ seed;
}

export interface SimOutage {
  entry: SimPing;
  exit: SimPing;
  startedAt: number;
  recoveredAt: number;
}

/**
 * The outages the presence sweeper would record for a simulated trip: whenever the newest fix
 * the gateway holds is at least 9× its cadence old when the next batch lands (ARCH §5.7), the
 * bus was DARK from that fix until that batch. Pure, so the learner can be checked without a
 * running stack.
 */
export function outagesOf(trip: SimTrip): SimOutage[] {
  const arrivals = [...trip.batches].sort((a, b) => a.sendAt - b.sendAt);
  const out: SimOutage[] = [];
  let last: { ping: SimPing; t: number; cadenceS: number } | null = null;
  for (const b of arrivals) {
    const newest = b.pings.reduce((m, p) => (p.recorded_at > m.recorded_at ? p : m), b.pings[0]!);
    if (last && b.sendAt - last.t >= PRESENCE.DARK_CADENCE_MULTIPLE * last.cadenceS * 1000) {
      out.push({ entry: last.ping, exit: newest, startedAt: last.t, recoveredAt: b.sendAt });
    }
    const t = Date.parse(newest.recorded_at);
    if (!last || t > last.t) last = { ping: newest, t, cadenceS: b.cadenceS };
  }
  return out;
}

export interface ZoneCheck {
  route: string;
  /** injected zone as route offsets, metres */
  injected: [number, number];
  /** recovered outages recorded within 200 m of where the zone starts, and on how many trips */
  observed: number;
  trips: number;
  /** enough observations to be learned (≥ minPts on ≥ 2 trips): a zone crossed in under 45 s
   *  never turns a bus DARK, so it is never observed — correctly */
  learnable: boolean;
  /** the learned zone that covers the point the bus goes quiet at, if any */
  learned: { id: string; label: string | null; sampleCount: number } | null;
}

export interface DeadZoneVerdict {
  ok: boolean;
  zones: ZoneCheck[];
  /** injected zones with enough observations to be learned */
  learnable: number;
  found: number;
  missed: number;
  /** learned zones more than 300 m from the start of every injected zone */
  unexplained: { id: string; label: string | null }[];
}

/**
 * Compare `dead_zones` with what the simulator injected on every published route. Checks only
 * zones that saw enough traffic to be learnable: the caller passes the routes it drove.
 */
export async function verifyDeadZones(
  db: Db,
  opts: { seed: number; routeIds?: string[] },
): Promise<DeadZoneVerdict> {
  const published = (await listRoutes(db)).filter((r) => r.published_at && !r.archived_at);
  const routes = (
    await Promise.all(
      published
        .filter((r) => !opts.routeIds || opts.routeIds.includes(r.id))
        .map((r) => loadRoute(db, r.id)),
    )
  ).filter((r): r is LoadedRoute => r !== null);
  const learned = await db.query<{
    id: string;
    label: string | null;
    sample_count: number;
    ring: string;
  }>(
    `SELECT id, label, sample_count, ST_AsGeoJSON(polygon) AS ring
       FROM dead_zones WHERE retired_at IS NULL AND learned_at IS NOT NULL`,
  );
  const zones = learned.rows.map((z) => ({
    id: z.id,
    label: z.label,
    sampleCount: Number(z.sample_count),
    ring: (JSON.parse(z.ring).coordinates[0] as [number, number][]).map(([lng, lat]) => ({
      lat,
      lng,
    })),
  }));
  const checks: ZoneCheck[] = [];
  const starts: LatLng[] = [];
  for (const r of routes) {
    const name = published.find((p) => p.id === r.id)?.name ?? r.id;
    for (const z of deadZonesFor(r.route, routeZoneSeed(r.lineageId, opts.seed))) {
      // the bus goes quiet just before the zone: the last fix is up to one cadence early
      const at = pointAtOffset(r.route, Math.max(0, z[0] - 20));
      starts.push(at);
      const hit = zones.find((l) => ringContains(l.ring, at));
      const seen = await db.query<{ n: number; trips: number }>(
        `SELECT count(*)::int AS n, count(DISTINCT trip_id)::int AS trips FROM signal_outages
          WHERE exit_point IS NOT NULL
            AND ST_DWithin(entry_point, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 200)`,
        [at.lng, at.lat],
      );
      const observed = seen.rows[0]!.n;
      const trips = seen.rows[0]!.trips;
      checks.push({
        route: name,
        injected: [Math.round(z[0]), Math.round(z[1])],
        observed,
        trips,
        learnable: observed >= DEADZONE.MIN_PTS && trips >= DEADZONE.MIN_TRIPS,
        learned: hit ? { id: hit.id, label: hit.label, sampleCount: hit.sampleCount } : null,
      });
    }
  }
  const unexplained = zones
    .filter((l) => !starts.some((s) => l.ring.some((p) => haversine(p, s) < 300)))
    .map(({ id, label }) => ({ id, label }));
  const learnable = checks.filter((c) => c.learnable);
  const found = learnable.filter((c) => c.learned).length;
  return {
    ok: learnable.length > 0 && found === learnable.length && unexplained.length === 0,
    zones: checks,
    learnable: learnable.length,
    found,
    missed: learnable.length - found,
    unexplained,
  };
}
