import { z } from "zod";

/**
 * Stage 5: stop search, stop detail, the home pin, trip subscriptions, and the leave-now domain
 * event. Coordinates here are plain {lat, lng}.
 */

export const TravelMode = z.enum(["foot", "bicycle", "motorbike", "car"]);
export type TravelMode = z.infer<typeof TravelMode>;

export const StopSearchQuery = z.object({
  q: z.string().trim().min(2).max(80),
});

/**
 * One bus at one stop (BUILD_PLAN Stage 5 result rendering):
 *   running      "Bus 14 · 6 min · running"  (live ETA, or none while the signal is lost)
 *   passed       it has already been by today on this trip
 *   scheduled    "Bus 22 · 7:40 AM · scheduled"
 *   not_running  "Bus 27 · not running today"
 */
export const BusAtStop = z.object({
  busId: z.uuid(),
  number: z.string(),
  routeId: z.uuid(),
  routeName: z.string(),
  status: z.enum(["running", "passed", "scheduled", "not_running"]),
  tripId: z.uuid().nullable(),
  /** route_stops.seq of this stop on that route */
  seq: z.number().int(),
  /** live ETA, seconds from `etaAt` — never set for a bus that is not reporting */
  eta: z
    .object({
      p50: z.number(),
      p90: z.number(),
      confidence: z.enum(["high", "medium", "low"]),
      at: z.iso.datetime({ offset: true }),
    })
    .nullable(),
  presence: z.enum(["LIVE", "DEGRADED", "DARK", "ENDED"]).nullable(),
  scheduledAt: z.iso.datetime({ offset: true }).nullable(),
});
export type BusAtStop = z.infer<typeof BusAtStop>;

export const StopResult = z.object({
  stopId: z.uuid(),
  name: z.string(),
  areaName: z.string().nullable(),
  landmark: z.string().nullable(),
  lat: z.number(),
  lng: z.number(),
  /** how it matched: by its name or an alias (fuzzy), by locality, or by being near the place */
  match: z.enum(["name", "alias", "area", "nearby"]),
  /** trigram similarity for text matches; null for nearby */
  similarity: z.number().nullable(),
  /** metres from the searched place (area search), null otherwise */
  distanceM: z.number().nullable(),
  buses: z.array(BusAtStop),
});
export type StopResult = z.infer<typeof StopResult>;

export const StopSearchResponse = z.object({
  query: z.string(),
  /** the place a nearby search was centred on: the best stop, or a geocoded locality */
  anchor: z
    .object({
      label: z.string(),
      lat: z.number(),
      lng: z.number(),
      source: z.enum(["stop", "geocoder"]),
    })
    .nullable(),
  results: z.array(StopResult),
});
export type StopSearchResponse = z.infer<typeof StopSearchResponse>;

export const WalkEta = z.object({
  mode: TravelMode,
  durationS: z.number().int(),
  distanceM: z.number().int(),
  computedAt: z.iso.datetime({ offset: true }),
});
export type WalkEta = z.infer<typeof WalkEta>;

export const StopDetail = StopResult.extend({
  /** from the student's pinned home, by their travel mode; null without a pin */
  walk: WalkEta.nullable(),
});
export type StopDetail = z.infer<typeof StopDetail>;

/** PUT /v1/me/home — stored coarsened to ~100 m by the database (ARCH §10). */
export const HomePin = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  label: z.string().trim().max(60).nullable().optional(),
  travelMode: TravelMode.optional(),
});
export type HomePin = z.infer<typeof HomePin>;

export const Me = z.object({
  id: z.uuid(),
  rollNo: z.string(),
  fullName: z.string(),
  home: z.object({ lat: z.number(), lng: z.number(), label: z.string().nullable() }).nullable(),
  travelMode: TravelMode,
  bufferS: z.number().int(),
});
export type Me = z.infer<typeof Me>;

/** POST /v1/me/subscription — "I am taking this bus today, from this stop". */
export const Subscribe = z.object({ tripId: z.uuid(), stopId: z.uuid() });
export type Subscribe = z.infer<typeof Subscribe>;

export const SubscriptionView = z.object({
  id: z.uuid(),
  tripId: z.uuid(),
  busId: z.uuid(),
  busNumber: z.string(),
  routeId: z.uuid(),
  routeName: z.string(),
  stop: z.object({ id: z.uuid(), name: z.string(), seq: z.number().int(), offset: z.number() }),
  state: z.enum(["active", "muted", "boarded", "completed", "missed"]),
  travelMode: TravelMode,
  /** home → stop, seconds; null without a pin */
  travelTimeS: z.number().int().nullable(),
  bufferS: z.number().int(),
  notifiedDepartureAt: z.string().nullable(),
  createdAt: z.string(),
});
export type SubscriptionView = z.infer<typeof SubscriptionView>;

/**
 * `stream:notify` — domain events for the notification spine. Stage 5 emits; Stage 6 delivers.
 * Never on `stream:events`: they name a student (invariant 9).
 */
export const LeaveNowEvent = z.object({
  type: z.literal("leave_now"),
  subscriptionId: z.uuid(),
  userId: z.uuid(),
  tripId: z.uuid(),
  busId: z.uuid(),
  stopId: z.uuid(),
  /** remaining bus ETA to the stop when it fired, seconds */
  etaP50S: z.number(),
  etaP90S: z.number(),
  travelTimeS: z.number(),
  bufferS: z.number(),
  at: z.iso.datetime({ offset: true }),
});
export type LeaveNowEvent = z.infer<typeof LeaveNowEvent>;
