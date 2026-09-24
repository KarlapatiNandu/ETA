import type { DraftStop, RouteDetail, RouteSummary, SaveDraft } from "@busmitra/contracts";
import type { Queryable } from "@busmitra/db";
import { buildRoute, projectStops, type LatLng, type Route, type RouteStop } from "@busmitra/geo";
import { lineWkt } from "./workers/survey.ts";

/**
 * Routes: loading them for the geo worker, and the draft → publish lifecycle behind the admin
 * route editor (ADR-0003). Published routes are immutable in the database itself (0003
 * triggers); these functions are the only code that creates versions.
 */

const httpError = (statusCode: number, message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { statusCode, ...extra });

/** A stop further than this from the line gets a warning in the editor, not a refusal. */
export const STOP_WARN_DISTANCE_M = 50;

export interface LoadedRoute {
  id: string;
  lineageId: string;
  route: Route;
  stops: RouteStop[];
  /** route_stops.expected_dwell_s, parallel to `stops` (ARCH §5.5 expectedDwell) */
  dwellS?: number[];
}

type Coord = [number, number];

/** Geometry + D[] + ordered stops: everything snapping and crossing detection need. */
export async function loadRoute(q: Queryable, routeId: string): Promise<LoadedRoute | null> {
  const { rows } = await q.query<{ lineage_id: string; coords: Coord[]; cum: number[] }>(
    `SELECT lineage_id, (ST_AsGeoJSON(geometry)::json -> 'coordinates') AS coords,
            cumulative_dist_m AS cum
       FROM routes WHERE id = $1`,
    [routeId],
  );
  const r = rows[0];
  if (!r) return null;
  const stops = await q.query<{ seq: number; stop_id: string; d: number; dwell: number }>(
    `SELECT seq, stop_id, cumulative_dist_m AS d, expected_dwell_s AS dwell
       FROM route_stops WHERE route_id = $1 ORDER BY seq`,
    [routeId],
  );
  return {
    id: routeId,
    lineageId: r.lineage_id,
    route: buildRoute(
      r.coords.map(([lng, lat]) => ({ lat, lng })),
      r.cum,
    ),
    stops: stops.rows.map((s) => ({ seq: s.seq, stopId: s.stop_id, offset: s.d })),
    dwellS: stops.rows.map((s) => Number(s.dwell)),
  };
}

const SUMMARY_COLS = `r.id, r.lineage_id, r.name, r.direction, r.version, r.source,
  r.published_at, r.archived_at, r.total_distance_m,
  (SELECT count(*)::int FROM route_stops rs WHERE rs.route_id = r.id) AS stop_count`;

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null ? null : String(v));

function toSummary(r: Record<string, unknown>): RouteSummary {
  return {
    id: r.id as string,
    lineage_id: r.lineage_id as string,
    name: r.name as string,
    direction: r.direction as RouteSummary["direction"],
    version: Number(r.version),
    source: r.source as RouteSummary["source"],
    published_at: iso(r.published_at),
    archived_at: iso(r.archived_at),
    total_distance_m: Number(r.total_distance_m),
    stop_count: Number(r.stop_count),
  };
}

export async function listRoutes(q: Queryable): Promise<RouteSummary[]> {
  const { rows } = await q.query(
    `SELECT ${SUMMARY_COLS} FROM routes r ORDER BY r.name, r.direction, r.version DESC`,
  );
  return rows.map(toSummary);
}

export async function getRouteDetail(q: Queryable, id: string): Promise<RouteDetail | null> {
  const { rows } = await q.query(
    `SELECT ${SUMMARY_COLS}, (ST_AsGeoJSON(r.geometry)::json -> 'coordinates') AS coords
       FROM routes r WHERE r.id = $1`,
    [id],
  );
  if (!rows[0]) return null;
  const stops = await q.query<{
    seq: number;
    stop_id: string;
    name: string;
    aliases: string[];
    area_name: string | null;
    landmark: string | null;
    lat: number;
    lng: number;
    offset_m: number;
  }>(
    `SELECT rs.seq, rs.stop_id, s.name, s.aliases, s.area_name, s.landmark,
            ST_Y(s.location::geometry) AS lat, ST_X(s.location::geometry) AS lng,
            rs.cumulative_dist_m AS offset_m
       FROM route_stops rs JOIN stops s ON s.id = rs.stop_id
      WHERE rs.route_id = $1 ORDER BY rs.seq`,
    [id],
  );
  return {
    ...toSummary(rows[0]),
    coords: rows[0].coords as Coord[],
    stops: stops.rows.map((s) => ({ ...s, seq: Number(s.seq), offset_m: Number(s.offset_m) })),
  };
}

async function draftRow(q: Queryable, id: string) {
  const { rows } = await q.query<{ published_at: Date | null; archived_at: Date | null }>(
    `SELECT published_at, archived_at FROM routes WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const r = rows[0];
  if (!r) throw httpError(404, "No such route.");
  if (r.published_at) {
    throw httpError(409, "This version is published and frozen. Create a new version to edit it.");
  }
  if (r.archived_at) throw httpError(409, "This draft was archived.");
}

export interface SaveWarning {
  seq: number;
  kind: "far_from_route";
  distance_m: number;
}

/**
 * Replace a draft's geometry (if given) and its stops. Each stop's D_k is computed here by
 * projecting it onto the line — the one number the arrival algorithm runs on (SCHEMA §3).
 * Stops must end up in route order: a stop that can only sit behind the previous one is
 * refused, because the crossing detector enforces sequence and would wait for it for ever.
 */
export async function saveDraft(
  q: Queryable,
  id: string,
  body: SaveDraft,
): Promise<{ warnings: SaveWarning[] }> {
  await draftRow(q, id);
  if (body.coords) {
    await q.query(`UPDATE routes SET geometry = $2::geography WHERE id = $1`, [
      id,
      lineWkt(body.coords.map(([lng, lat]) => ({ lat, lng }))),
    ]);
  }
  const loaded = (await loadRoute(q, id))!;
  const points = await resolveStops(q, body.stops);
  const placed = projectStops(
    loaded.route,
    points.map((p, i) => ({ point: p.point, near: body.stops[i]!.near_offset_m ?? null })),
  );
  const backwards = placed.findIndex((p) => p.outOfOrder);
  if (backwards !== -1) {
    throw httpError(
      422,
      `Stop ${backwards + 1} would sit behind stop ${backwards}: reorder the stops.`,
      {
        code: "stops_out_of_order",
      },
    );
  }
  await q.query(`DELETE FROM route_stops WHERE route_id = $1`, [id]);
  const warnings: SaveWarning[] = [];
  for (const [i, p] of placed.entries()) {
    await q.query(
      `INSERT INTO route_stops (route_id, seq, stop_id, cumulative_dist_m) VALUES ($1, $2, $3, $4)`,
      [id, i + 1, points[i]!.stopId, p.s],
    );
    if (p.distance > STOP_WARN_DISTANCE_M) {
      warnings.push({ seq: i + 1, kind: "far_from_route", distance_m: Math.round(p.distance) });
    }
  }
  return { warnings };
}

async function resolveStops(
  q: Queryable,
  stops: readonly DraftStop[],
): Promise<{ stopId: string; point: LatLng }[]> {
  const out: { stopId: string; point: LatLng }[] = [];
  for (const s of stops) {
    if (s.stop_id) {
      const { rows } = await q.query<{ lat: number; lng: number }>(
        `SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
           FROM stops WHERE id = $1 AND archived_at IS NULL`,
        [s.stop_id],
      );
      if (!rows[0]) throw httpError(422, `Unknown stop ${s.stop_id}.`);
      out.push({ stopId: s.stop_id, point: rows[0] });
    } else {
      const n = s.new_stop!;
      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO stops (name, aliases, area_name, landmark, location)
         VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography) RETURNING id`,
        [n.name, n.aliases, n.area_name ?? null, n.landmark ?? null, n.lng, n.lat],
      );
      out.push({ stopId: rows[0]!.id, point: { lat: n.lat, lng: n.lng } });
    }
  }
  return out;
}

/**
 * Publish a draft: freeze it and retire the version it replaces, atomically (the caller runs
 * this in one transaction). A route that serves the same stop twice is legitimate for a
 * circular route (SCHEMA §3), so it is a warning a human confirms, not a wall.
 */
export async function publishRoute(
  q: Queryable,
  id: string,
  opts: { confirmRepeatedStops: boolean },
): Promise<RouteSummary> {
  await draftRow(q, id);
  const { rows: stops } = await q.query<{ stop_id: string; name: string }>(
    `SELECT rs.stop_id, s.name FROM route_stops rs JOIN stops s ON s.id = rs.stop_id
      WHERE rs.route_id = $1 ORDER BY rs.seq`,
    [id],
  );
  if (stops.length < 2)
    throw httpError(422, "A route needs at least two stops before it can be published.");
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const s of stops) (seen.has(s.stop_id) ? repeated : seen).add(s.stop_id);
  if (repeated.size && !opts.confirmRepeatedStops) {
    const names = stops.filter((s) => repeated.has(s.stop_id)).map((s) => s.name);
    throw httpError(409, `This route serves ${[...new Set(names)].join(", ")} more than once.`, {
      code: "repeated_stops",
      stops: [...new Set(names)],
    });
  }
  await q.query(
    `UPDATE routes SET archived_at = now()
      WHERE lineage_id = (SELECT lineage_id FROM routes WHERE id = $1)
        AND id <> $1 AND published_at IS NOT NULL AND archived_at IS NULL`,
    [id],
  );
  await q.query(`UPDATE routes SET published_at = now() WHERE id = $1`, [id]);
  const { rows } = await q.query(`SELECT ${SUMMARY_COLS} FROM routes r WHERE r.id = $1`, [id]);
  return toSummary(rows[0]!);
}

/** Start editing a published route: copy it into the next version as a draft (or reuse one). */
export async function newVersion(
  q: Queryable,
  id: string,
): Promise<{ id: string; version: number }> {
  const { rows: src } = await q.query<{ lineage_id: string }>(
    `SELECT lineage_id FROM routes WHERE id = $1`,
    [id],
  );
  if (!src[0]) throw httpError(404, "No such route.");
  const open = await q.query<{ id: string; version: number }>(
    `SELECT id, version FROM routes
      WHERE lineage_id = $1 AND published_at IS NULL AND archived_at IS NULL
      ORDER BY version DESC LIMIT 1`,
    [src[0].lineage_id],
  );
  if (open.rows[0]) return open.rows[0];
  const { rows } = await q.query<{ id: string; version: number }>(
    `INSERT INTO routes (lineage_id, name, direction, geometry, source, version)
     SELECT lineage_id, name, direction, geometry, source,
            (SELECT max(version) + 1 FROM routes WHERE lineage_id = r.lineage_id)
       FROM routes r WHERE id = $1
     RETURNING id, version`,
    [id],
  );
  await q.query(
    `INSERT INTO route_stops (route_id, seq, stop_id, cumulative_dist_m, scheduled_offset_s, expected_dwell_s)
     SELECT $2, seq, stop_id, cumulative_dist_m, scheduled_offset_s, expected_dwell_s
       FROM route_stops WHERE route_id = $1`,
    [id, rows[0]!.id],
  );
  return rows[0]!;
}

/** Discard an unpublished draft. */
export async function deleteDraft(q: Queryable, id: string): Promise<void> {
  await draftRow(q, id);
  await q.query(
    `UPDATE route_surveys SET route_id = NULL, status = 'uploaded' WHERE route_id = $1`,
    [id],
  );
  await q.query(`DELETE FROM routes WHERE id = $1`, [id]);
}
