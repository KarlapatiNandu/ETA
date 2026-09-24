import type { Queryable } from "@busmitra/db";
import { buildRoute } from "@busmitra/geo";
import { TTL, type Keys, type Redis } from "@busmitra/redis";
import { loadRoute, type LoadedRoute } from "../routes.ts";

/**
 * Route geometry for the workers: process memory → Redis (`route:{id}:geom`, 24 h) →
 * Postgres. Published routes are immutable, so a cached copy can never be stale — and a
 * route already in Redis keeps the live map working through a Postgres outage (ARCH §11).
 */
export class RouteCache {
  private readonly mem = new Map<string, LoadedRoute>();
  private readonly db: Queryable;
  private readonly redis: Redis;
  private readonly keys: Keys;

  constructor(db: Queryable, redis: Redis, keys: Keys) {
    this.db = db;
    this.redis = redis;
    this.keys = keys;
  }

  async get(routeId: string): Promise<LoadedRoute | null> {
    const hit = this.mem.get(routeId);
    if (hit) return hit;
    const packed = await this.redis.get(this.keys.routeGeom(routeId));
    if (packed) {
      const p = JSON.parse(packed) as Omit<LoadedRoute, "route"> & {
        coords: LoadedRoute["route"]["coords"];
        cum: number[];
      };
      const loaded: LoadedRoute = {
        id: p.id,
        lineageId: p.lineageId,
        stops: p.stops,
        dwellS: p.dwellS,
        route: buildRoute(p.coords, p.cum),
      };
      this.mem.set(routeId, loaded);
      return loaded;
    }
    const loaded = await loadRoute(this.db, routeId);
    if (!loaded) return null;
    await this.redis.set(
      this.keys.routeGeom(routeId),
      JSON.stringify({
        id: loaded.id,
        lineageId: loaded.lineageId,
        stops: loaded.stops,
        dwellS: loaded.dwellS,
        coords: loaded.route.coords,
        cum: loaded.route.cum,
      }),
      "EX",
      TTL.ROUTE_GEOM_S,
    );
    this.mem.set(routeId, loaded);
    return loaded;
  }
}
