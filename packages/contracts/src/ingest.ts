import { z } from "zod";
import { Ping } from "./ping.ts";

/**
 * Tracker ↔ gateway (Stage 2) and gateway → engine (the `stream:pings` entries).
 *
 * Every tracker request is signed: HMAC-SHA256 with the per-device secret over
 * `signingPayload(device_uid, timestamp, rawBody)`, hex-encoded (ARCH §10). The driver PWA
 * (WebCrypto) and the gateway (node:crypto) both build the payload with this one function,
 * so they cannot drift apart.
 */

export { signingPayload, TRACKER_HEADERS } from "./signing.ts";

/** POST /v1/ingest response. Rejected pings must not be retried; everything else was taken. */
export const IngestResult = z.object({
  accepted: z.number().int().nonnegative(),
  rejected: z.array(z.object({ index: z.number().int(), reason: z.string() })),
});
export type IngestResult = z.infer<typeof IngestResult>;

/** One validated ping on `stream:pings` — what the geo worker and the persister consume. */
export const StreamPing = z.object({
  kind: z.literal("ping"),
  trip_id: z.uuid(),
  bus_id: z.uuid(),
  /** resolved by the gateway when it validated the trip, so the geo worker needs no DB read */
  route_id: z.uuid(),
  device_uid: z.string(),
  cadence_s: z.number().int().positive(),
  recorded_at: z.iso.datetime({ offset: true }),
  ingested_at: z.iso.datetime({ offset: true }),
  lat: z.number(),
  lng: z.number(),
  speed_kmh: z.number().nullable(),
  heading_deg: z.number().int().nullable(),
  accuracy_m: z.number().nullable(),
  /** ingested_at − recorded_at > 30 s (ARCH §5.7): persisted, never notifies, never overwrites live */
  is_backfill: z.boolean(),
});
export type StreamPing = z.infer<typeof StreamPing>;

/** Explicit trip end, ordered with the pings so the geo worker sees it after the last one. */
export const StreamTripEnd = z.object({
  kind: z.literal("trip_end"),
  trip_id: z.uuid(),
  bus_id: z.uuid(),
  route_id: z.uuid(),
  at: z.iso.datetime({ offset: true }),
});
export type StreamTripEnd = z.infer<typeof StreamTripEnd>;

export const StreamMessage = z.discriminatedUnion("kind", [StreamPing, StreamTripEnd]);
export type StreamMessage = z.infer<typeof StreamMessage>;

// ── tracker API (signed like ingest) ──────────────────────────────────────

export const TrackerRoute = z.object({
  id: z.uuid(),
  name: z.string(),
  direction: z.enum(["inbound", "outbound"]),
  version: z.number().int(),
});
export type TrackerRoute = z.infer<typeof TrackerRoute>;

/** GET /v1/tracker/me — who this device is, what it can drive, and any trip to resume. */
export const TrackerMe = z.object({
  device_uid: z.string(),
  bus: z.object({ id: z.uuid(), bus_number: z.string() }).nullable(),
  routes: z.array(TrackerRoute),
  live_trip: z.object({ id: z.uuid(), route_id: z.uuid(), started_at: z.string() }).nullable(),
  /**
   * Stage 9 (additive): the bus's regular route. A wired tracker has no driver to pick one, so
   * the hardware adapter starts its ignition-driven trips here. Optional: older gateways omit it.
   */
  default_route_id: z.uuid().nullable().optional(),
  /** gateway clock, so a phone with a wrong clock can be told before its pings bounce */
  server_time: z.iso.datetime({ offset: true }),
});
export type TrackerMe = z.infer<typeof TrackerMe>;

export const TripStart = z.object({ route_id: z.uuid() });
export type TripStart = z.infer<typeof TripStart>;

export const TripStarted = z.object({
  trip_id: z.uuid(),
  route_id: z.uuid(),
  /** true when the bus already had a live trip on this route (app restarted mid-trip) */
  resumed: z.boolean(),
  started_at: z.string(),
});
export type TripStarted = z.infer<typeof TripStarted>;

// ── survey mode (Stage 1 route capture) ───────────────────────────────────

export const SurveyPoint = Ping.pick({
  lat: true,
  lng: true,
  accuracy_m: true,
  speed_kmh: true,
}).extend({
  t: z.iso.datetime({ offset: true }),
});
export type SurveyPoint = z.infer<typeof SurveyPoint>;

/** POST /v1/survey — a raw 1 Hz trace, uploaded once at the end of the drive. */
export const SurveyUpload = z.object({
  label: z.string().trim().max(120).optional(),
  /** a 45-minute route at 1 Hz is ~2,700 points; 20,000 is a 5½-hour ceiling */
  points: z.array(SurveyPoint).min(10).max(20_000),
});
export type SurveyUpload = z.infer<typeof SurveyUpload>;

export const SurveyAccepted = z.object({ survey_id: z.uuid(), point_count: z.number().int() });
export type SurveyAccepted = z.infer<typeof SurveyAccepted>;
