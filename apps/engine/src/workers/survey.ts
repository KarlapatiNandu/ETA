import { randomUUID } from "node:crypto";
import type { SurveyPoint } from "@busmitra/contracts";
import { withContext, type Db, type Queryable, type RequestContext } from "@busmitra/db";
import {
  chunkWindows,
  dedupe,
  haversine,
  MATCH,
  simplifyTrace,
  stitchChunks,
  type LatLng,
  type MatchedChunk,
} from "@busmitra/geo";
import type { Osrm } from "../osrm.ts";

/**
 * The trace → route pipeline (BUILD_PLAN Stage 1): how a published route is made from nothing
 * but a phone driven along it once.
 *
 *   raw 1 Hz trace → drop bad fixes → simplify (Douglas–Peucker) → OSRM /match in chunks of
 *   ≤80 points with 15 of overlap → stitch → canonical polyline → draft route row
 *   (cumulative_dist_m by trigger) with a lineage (new corridor) or an inherited one (re-survey)
 */

export const PIPELINE = {
  /** fixes worse than this are more likely to pull the match onto a parallel road than help */
  MAX_ACCURACY_M: 50,
  /**
   * DP tolerance on the raw trace, before matching. At GPS-noise scale: below it, noise alone
   * keeps a third of a 1 Hz trace. Safe to be this coarse because the route's geometry comes
   * from OSRM's road network, not from the kept points — they only have to be on the right road.
   */
  SIMPLIFY_M: 10,
  /** never leave more than this between kept points, or OSRM may route a different way round */
  MAX_GAP_M: 250,
  /** DP tolerance on the matched road geometry: drops collinear vertices, keeps every bend */
  FINAL_SIMPLIFY_M: 1,
  /** the matching radius for a point with no reported accuracy */
  DEFAULT_RADIUS_M: 20,
} as const;

type TimedPoint = LatLng & { t: number; radiusM: number };

/** Drop unusable fixes, sort by time, simplify, then re-densify gaps longer than MAX_GAP_M. */
export function prepareTrace(points: readonly SurveyPoint[]): TimedPoint[] {
  const usable = points
    .filter((p) => p.accuracy_m == null || p.accuracy_m <= PIPELINE.MAX_ACCURACY_M)
    .map((p) => ({
      lat: p.lat,
      lng: p.lng,
      t: Date.parse(p.t),
      radiusM: Math.min(50, Math.max(10, p.accuracy_m ?? PIPELINE.DEFAULT_RADIUS_M)),
    }))
    .sort((a, b) => a.t - b.t);
  const clean = dedupe(usable);
  if (clean.length <= 2) return clean;
  const kept = new Set(simplifyTrace(clean, PIPELINE.SIMPLIFY_M));
  const out: TimedPoint[] = [];
  let last: TimedPoint | null = null;
  for (let i = 0; i < clean.length; i++) {
    const p = clean[i]!;
    const next = clean[i + 1];
    // keep DP's vertices, plus the last point before the gap from the previous kept point
    // would exceed MAX_GAP_M (so no gap does, unless one 1 s step alone is longer)
    if (kept.has(p) || (last && next && haversine(last, next) >= PIPELINE.MAX_GAP_M)) {
      out.push(p);
      last = p;
    }
  }
  return out;
}

export interface MatchReport {
  inputPoints: number;
  matchedInput: number;
  chunks: number;
  /** joins between chunks with no commonly matched point — look at these seams in the editor */
  gaps: number;
  /** share of submitted points OSRM could place on a road */
  matchedPct: number;
  vertices: number;
  lengthM: number;
}

export async function matchTrace(
  osrm: Osrm,
  points: readonly SurveyPoint[],
): Promise<{ line: LatLng[]; report: MatchReport }> {
  const trace = prepareTrace(points);
  if (trace.length < 2) throw new Error("survey has fewer than two usable points");
  const windows = chunkWindows(trace.length, MATCH.CHUNK, MATCH.OVERLAP);
  const chunks: MatchedChunk[] = [];
  let matched = 0;
  for (const [start, end] of windows) {
    const slice = trace.slice(start, end);
    const res = await osrm.match(slice);
    chunks.push({ start, geometry: res.matchings.flat(), tracepoints: res.tracepoints });
    matched += res.tracepoints.filter(Boolean).length;
  }
  const { line: stitched, gaps } = stitchChunks(chunks);
  const line = dedupe(simplifyTrace(stitched, PIPELINE.FINAL_SIMPLIFY_M));
  if (line.length < 2) throw new Error("OSRM could not match the survey to any road");
  const lengthM = line.slice(1).reduce((sum, p, i) => sum + haversine(line[i]!, p), 0);
  const submitted = windows.reduce((n, [s, e]) => n + (e - s), 0);
  return {
    line,
    report: {
      inputPoints: points.length,
      matchedInput: trace.length,
      chunks: windows.length,
      gaps,
      matchedPct: Math.round((matched / submitted) * 1000) / 10,
      vertices: line.length,
      lengthM: Math.round(lengthM),
    },
  };
}

export function lineWkt(line: readonly LatLng[]): string {
  return `SRID=4326;LINESTRING(${line.map((p) => `${p.lng} ${p.lat}`).join(",")})`;
}

/**
 * Insert a draft route. A new corridor gets a fresh lineage; a re-survey passes the lineage it
 * corrects and becomes the next version of it, so the learned traffic model and dead zones
 * (keyed by lineage — invariant 7) carry across.
 */
export async function insertDraftRoute(
  q: Queryable,
  opts: {
    name: string;
    direction: "inbound" | "outbound";
    line: readonly LatLng[];
    source: "gps_survey" | "osrm_derived" | "manual_draw";
    lineageId?: string | null;
  },
): Promise<{ id: string; lineageId: string; version: number }> {
  const lineageId = opts.lineageId ?? randomUUID();
  const { rows } = await q.query<{ id: string; version: number }>(
    `INSERT INTO routes (lineage_id, name, direction, geometry, source, version)
     VALUES ($1, $2, $3::direction_t, $4::geography, $5::route_source_t,
             COALESCE((SELECT max(version) + 1 FROM routes WHERE lineage_id = $1), 1))
     RETURNING id, version`,
    [lineageId, opts.name, opts.direction, lineWkt(opts.line), opts.source],
  );
  return { id: rows[0]!.id, lineageId, version: rows[0]!.version };
}

/**
 * Run the pipeline for one uploaded survey and record the draft it produced. The OSRM calls
 * (one per 80-point chunk — ~35 for a 45-minute survey) run before the transaction opens, so no
 * row is locked while a routing server is being waited on.
 */
export async function matchSurvey(
  db: Db,
  deps: { osrm: Osrm; readTrace: (path: string) => Promise<string> },
  surveyId: string,
  opts: { name: string; direction: "inbound" | "outbound"; lineageId?: string | null },
  ctx: RequestContext = { actorId: null, ip: null, userAgent: null },
): Promise<{ routeId: string; report: MatchReport }> {
  const { rows } = await db.query<{ file_path: string; status: string }>(
    `SELECT file_path, status FROM route_surveys WHERE id = $1`,
    [surveyId],
  );
  const survey = rows[0];
  if (!survey) throw Object.assign(new Error("No such survey."), { statusCode: 404 });
  if (survey.status === "discarded") {
    throw Object.assign(new Error("Survey was discarded."), { statusCode: 409 });
  }
  const points = (JSON.parse(await deps.readTrace(survey.file_path)) as { points: SurveyPoint[] })
    .points;
  const { line, report } = await matchTrace(deps.osrm, points);
  return withContext(db, ctx, async (q) => {
    const cur = await q.query<{ status: string }>(
      `SELECT status FROM route_surveys WHERE id = $1 FOR UPDATE`,
      [surveyId],
    );
    if (cur.rows[0]?.status === "discarded") {
      throw Object.assign(new Error("Survey was discarded."), { statusCode: 409 });
    }
    const route = await insertDraftRoute(q, { ...opts, line, source: "gps_survey" });
    await q.query(
      `UPDATE route_surveys SET status = 'matched', route_id = $2, match_report = $3 WHERE id = $1`,
      [surveyId, route.id, JSON.stringify(report)],
    );
    return { routeId: route.id, report };
  });
}
