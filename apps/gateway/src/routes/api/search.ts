import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { StopSearchQuery, type StopDetail, type StopSearchResponse } from "@busmitra/contracts";
import type { Queryable } from "@busmitra/db";
import type { Osrm } from "@busmitra/engine/osrm";
import { travelTime } from "@busmitra/engine/walk";
import type { Keys, Redis } from "@busmitra/redis";
import { requireUser } from "../../plugins/auth.ts";
import type { Geocoder } from "../../services/geocoder.ts";
import { describeStops, searchStops } from "../../services/search.ts";

/**
 * GET /v1/search/stops?q=   and   GET /v1/stops/:id   (BUILD_PLAN Stage 5).
 * Signed-in students only; rate-limited per IP because every keystroke is a request.
 */
export interface SearchRouteDeps {
  db: Queryable;
  redis?: Redis;
  keys?: Keys;
  geocoder?: Geocoder;
  osrmFoot?: Osrm;
  osrmCar?: Osrm;
}

export async function searchRoutes(app: FastifyInstance, deps: SearchRouteDeps) {
  const limit = { rateLimit: { max: 120, timeWindow: "1 minute" } };

  app.get(
    "/v1/search/stops",
    { preHandler: requireUser, config: limit },
    async (req): Promise<StopSearchResponse> => {
      const { q } = StopSearchQuery.parse(req.query);
      return searchStops(deps, q);
    },
  );

  app.get("/v1/stops/:id", { preHandler: requireUser, config: limit }, async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const [stop] = await describeStops(deps, [
      { stopId: id, match: "name", similarity: null, distanceM: null },
    ]);
    if (!stop) return reply.code(404).send({ error: "not_found", message: "No such stop." });
    const walk = await travelTime(
      { db: deps.db, foot: deps.osrmFoot, car: deps.osrmCar },
      req.user!.id,
      id,
    ).catch(() => null);
    const detail: StopDetail = { ...stop, walk };
    return detail;
  });
}
