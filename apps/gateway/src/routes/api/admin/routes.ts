import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  MatchSurvey,
  PublishRoute,
  SaveDraft,
  type StopSearchHit,
  type SurveySummary,
} from "@busmitra/contracts";
import { withContext } from "@busmitra/db";
import {
  deleteDraft,
  getRouteDetail,
  listRoutes,
  newVersion,
  publishRoute,
  saveDraft,
} from "@busmitra/engine/routes";
import { matchSurvey } from "@busmitra/engine/survey";
import type { AppDeps } from "../../../app.ts";
import { contextOf, requireAdmin } from "../../../plugins/auth.ts";

const Id = z.object({ id: z.uuid() });

/** Only the fields sent change: no defaults here, or a rename would wipe a stop's aliases. */
const StopPatch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  aliases: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
  area_name: z.string().trim().max(80).nullable().optional(),
  landmark: z.string().trim().max(120).nullable().optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

/**
 * The admin route editor's API (BUILD_PLAN Stage 1): surveys → matched drafts → corrected →
 * published. Role-gated (404 for everyone else, like every /v1/admin route), and every
 * mutation runs through withContext so audit_log records who did it (SCHEMA §8).
 */
export async function adminRouteRoutes(app: FastifyInstance, deps: AppDeps) {
  app.addHook("preHandler", requireAdmin(deps));

  app.get("/v1/admin/surveys", async (): Promise<SurveySummary[]> => {
    const { rows } = await deps.db.query<SurveySummary & { started_at: Date; ended_at: Date }>(
      `SELECT s.id, s.label, b.bus_number, s.started_at, s.ended_at, s.point_count,
              s.status, s.route_id, s.match_report
         FROM route_surveys s LEFT JOIN buses b ON b.id = s.bus_id
        ORDER BY s.created_at DESC LIMIT 100`,
    );
    return rows.map((r) => ({
      ...r,
      started_at: new Date(r.started_at).toISOString(),
      ended_at: new Date(r.ended_at).toISOString(),
    }));
  });

  app.post("/v1/admin/surveys/:id/match", async (req, reply) => {
    const { id } = Id.parse(req.params);
    const body = MatchSurvey.parse(req.body);
    if (!deps.osrm || !deps.surveyFiles) {
      return reply.code(503).send({ error: "unavailable", message: "Routing is not configured." });
    }
    const files = deps.surveyFiles;
    try {
      const out = await matchSurvey(
        deps.db,
        { osrm: deps.osrm, readTrace: (p) => files.get(p) },
        id,
        { name: body.name, direction: body.direction, lineageId: body.lineage_id ?? null },
        contextOf(req),
      );
      return { route_id: out.routeId, report: out.report };
    } catch (err) {
      if (
        (err as { name?: string }).name === "OsrmError" ||
        (err as Error).message.includes("fetch failed")
      ) {
        return reply
          .code(503)
          .send({ error: "routing_unavailable", message: "OSRM could not be reached." });
      }
      throw err;
    }
  });

  app.post("/v1/admin/surveys/:id/discard", async (req) => {
    const { id } = Id.parse(req.params);
    await withContext(deps.db, contextOf(req), (q) =>
      q.query(`UPDATE route_surveys SET status = 'discarded' WHERE id = $1`, [id]),
    );
    return { id, status: "discarded" };
  });

  app.get("/v1/admin/routes", async () => listRoutes(deps.db));

  app.get("/v1/admin/routes/:id", async (req, reply) => {
    const { id } = Id.parse(req.params);
    const detail = await getRouteDetail(deps.db, id);
    return detail ?? reply.code(404).send({ error: "not_found", message: "No such route." });
  });

  app.put("/v1/admin/routes/:id", async (req) => {
    const { id } = Id.parse(req.params);
    const body = SaveDraft.parse(req.body);
    const { warnings } = await withContext(deps.db, contextOf(req), (q) => saveDraft(q, id, body));
    return { route: await getRouteDetail(deps.db, id), warnings };
  });

  app.post("/v1/admin/routes/:id/publish", async (req) => {
    const { id } = Id.parse(req.params);
    const body = PublishRoute.parse(req.body ?? {});
    return withContext(deps.db, contextOf(req), (q) =>
      publishRoute(q, id, { confirmRepeatedStops: body.confirm_repeated_stops }),
    );
  });

  app.post("/v1/admin/routes/:id/versions", async (req) => {
    const { id } = Id.parse(req.params);
    return withContext(deps.db, contextOf(req), (q) => newVersion(q, id));
  });

  app.delete("/v1/admin/routes/:id", async (req) => {
    const { id } = Id.parse(req.params);
    await withContext(deps.db, contextOf(req), (q) => deleteDraft(q, id));
    return { id, deleted: true };
  });

  /**
   * Stop management (carried from Stage 1): rename, aliases, area and landmark always; moving or
   * archiving only a stop no published route depends on — a published route's D_k offsets were
   * measured against where the stop was, and moving it silently would put arrivals in the
   * wrong place. Such a stop is corrected by a new route version (ADR-0003).
   */
  app.patch("/v1/admin/stops/:id", async (req, reply) => {
    const { id } = Id.parse(req.params);
    const body = StopPatch.parse(req.body);
    const moving = body.lat !== undefined || body.lng !== undefined;
    if (moving && (body.lat === undefined || body.lng === undefined))
      return reply.code(400).send({ error: "invalid_request", message: "send both lat and lng" });
    if (moving) {
      const used = await usedByPublished(id);
      if (used.length)
        return reply.code(409).send({
          error: "stop_in_use",
          message: `Published routes use this stop (${used.join(", ")}). Move it in a new route version instead.`,
        });
    }
    const { rows } = await withContext(deps.db, contextOf(req), (q) =>
      q.query(
        `UPDATE stops SET name = COALESCE($2, name), aliases = COALESCE($3, aliases),
                area_name = CASE WHEN $4 THEN $5 ELSE area_name END,
                landmark = CASE WHEN $6 THEN $7 ELSE landmark END,
                location = CASE WHEN $8 THEN ST_SetSRID(ST_MakePoint($10, $9), 4326)::geography ELSE location END
          WHERE id = $1 AND archived_at IS NULL RETURNING id`,
        [
          id,
          body.name ?? null,
          body.aliases ?? null,
          body.area_name !== undefined,
          body.area_name ?? null,
          body.landmark !== undefined,
          body.landmark ?? null,
          moving,
          body.lat ?? 0,
          body.lng ?? 0,
        ],
      ),
    );
    if (!rows.length) return reply.code(404).send({ error: "not_found", message: "No such stop." });
    return { id };
  });

  app.post("/v1/admin/stops/:id/archive", async (req, reply) => {
    const { id } = Id.parse(req.params);
    const used = await usedByPublished(id);
    if (used.length)
      return reply.code(409).send({
        error: "stop_in_use",
        message: `Published routes use this stop (${used.join(", ")}). Remove it in a new route version first.`,
      });
    await withContext(deps.db, contextOf(req), (q) =>
      q.query(`UPDATE stops SET archived_at = now() WHERE id = $1 AND archived_at IS NULL`, [id]),
    );
    return { id, archived: true };
  });

  async function usedByPublished(stopId: string): Promise<string[]> {
    const { rows } = await deps.db.query<{ name: string }>(
      `SELECT DISTINCT r.name || ' v' || r.version AS name FROM route_stops rs JOIN routes r ON r.id = rs.route_id
        WHERE rs.stop_id = $1 AND r.published_at IS NOT NULL AND r.archived_at IS NULL`,
      [stopId],
    );
    return rows.map((r) => r.name);
  }

  /** Stops to reuse when building a route: by name, or near a point on the map. */
  app.get("/v1/admin/stops", async (req): Promise<StopSearchHit[]> => {
    const { q, lat, lng } = z
      .object({
        q: z.string().trim().max(80).optional(),
        lat: z.coerce.number().min(-90).max(90).optional(),
        lng: z.coerce.number().min(-180).max(180).optional(),
      })
      .parse(req.query);
    const near = lat !== undefined && lng !== undefined;
    const { rows } = await deps.db.query<StopSearchHit>(
      `SELECT id, name, area_name, aliases, landmark,
              ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
         FROM stops
        WHERE archived_at IS NULL
          AND ($1::text IS NULL OR name ILIKE '%' || $1 || '%' OR name % $1 OR $1 = ANY(aliases))
          AND (NOT $2 OR ST_DWithin(location, ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography, 500))
        ORDER BY CASE WHEN $2 THEN ST_Distance(location, ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography) END,
                 similarity(name, COALESCE($1, '')) DESC, name
        LIMIT 20`,
      [q || null, near, lat ?? 0, lng ?? 0],
    );
    return rows;
  });
}
