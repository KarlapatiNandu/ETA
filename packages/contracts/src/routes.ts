import { z } from "zod";

/** Admin route editor ↔ gateway (Stage 1). Coordinates are [lng, lat], GeoJSON order. */

export const LngLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
export type LngLat = z.infer<typeof LngLat>;

export const Direction = z.enum(["inbound", "outbound"]);

export const SurveySummary = z.object({
  id: z.uuid(),
  label: z.string().nullable(),
  bus_number: z.string().nullable(),
  started_at: z.string(),
  ended_at: z.string(),
  point_count: z.number().int(),
  status: z.enum(["uploaded", "matched", "discarded"]),
  route_id: z.uuid().nullable(),
  match_report: z.record(z.string(), z.unknown()).nullable(),
});
export type SurveySummary = z.infer<typeof SurveySummary>;

/** POST /v1/admin/surveys/:id/match — run the trace → route pipeline into a draft. */
export const MatchSurvey = z.object({
  name: z.string().trim().min(1).max(80),
  direction: Direction,
  /** re-survey of an existing corridor: inherit its lineage (keeps learned history, ADR-0003) */
  lineage_id: z.uuid().nullable().optional(),
});
export type MatchSurvey = z.infer<typeof MatchSurvey>;

export const RouteSummary = z.object({
  id: z.uuid(),
  lineage_id: z.uuid(),
  name: z.string(),
  direction: Direction,
  version: z.number().int(),
  source: z.enum(["gps_survey", "osrm_derived", "manual_draw"]),
  published_at: z.string().nullable(),
  archived_at: z.string().nullable(),
  total_distance_m: z.number(),
  stop_count: z.number().int(),
});
export type RouteSummary = z.infer<typeof RouteSummary>;

export const RouteStopView = z.object({
  seq: z.number().int(),
  stop_id: z.uuid(),
  name: z.string(),
  aliases: z.array(z.string()),
  area_name: z.string().nullable(),
  landmark: z.string().nullable(),
  lat: z.number(),
  lng: z.number(),
  offset_m: z.number(),
});
export type RouteStopView = z.infer<typeof RouteStopView>;

export const RouteDetail = RouteSummary.extend({
  coords: z.array(LngLat),
  stops: z.array(RouteStopView),
});
export type RouteDetail = z.infer<typeof RouteDetail>;

export const NewStop = z.object({
  name: z.string().trim().min(1).max(80),
  aliases: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
  area_name: z.string().trim().max(80).nullable().optional(),
  landmark: z.string().trim().max(120).nullable().optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type NewStop = z.infer<typeof NewStop>;

/** One stop on a draft, in route order: an existing stop, or one to create. */
export const DraftStop = z
  .object({
    stop_id: z.uuid().optional(),
    new_stop: NewStop.optional(),
    /** offset where the admin dropped it — picks the pass on a route that loops back */
    near_offset_m: z.number().nonnegative().nullable().optional(),
  })
  .refine((s) => (s.stop_id ? 1 : 0) + (s.new_stop ? 1 : 0) === 1, {
    message: "each stop is either an existing stop_id or a new_stop",
  });
export type DraftStop = z.infer<typeof DraftStop>;

/** PUT /v1/admin/routes/:id — replace a draft's geometry and stops. */
export const SaveDraft = z.object({
  coords: z.array(LngLat).min(2).max(20_000).optional(),
  stops: z.array(DraftStop).max(200),
});
export type SaveDraft = z.infer<typeof SaveDraft>;

export const PublishRoute = z.object({
  /** a route that repeats a stop publishes only once the admin has confirmed it is circular */
  confirm_repeated_stops: z.boolean().default(false),
});
export type PublishRoute = z.infer<typeof PublishRoute>;

export const StopSearchHit = z.object({
  id: z.uuid(),
  name: z.string(),
  area_name: z.string().nullable(),
  /** for the stop-management form (Stage 7); the route editor ignores them */
  aliases: z.array(z.string()).optional(),
  landmark: z.string().nullable().optional(),
  lat: z.number(),
  lng: z.number(),
});
export type StopSearchHit = z.infer<typeof StopSearchHit>;
